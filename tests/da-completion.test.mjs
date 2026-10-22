import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const origin = { tabId: 7, frameId: 0, documentId: "original-document", pageOrigin: "https://app.example" };
const message = {
  type: "AMAZON_EXTRACTION_COMPLETE",
  payload: { flowType: "extract-da-itineraries-data", date: "2026-10-03", period: "period",
    totalDrivers: 48, successfulDrivers: 48, failedDrivers: 0 },
};

function worker(send, currentUrl = "https://app.example/sync") {
  const calls = [];
  const logs = [];
  let listener;
  const api = vm.runInNewContext(
    background.replace('import { FLOW_REGISTRY } from "./flows/index.js";', "const FLOW_REGISTRY = {};") +
      "\n;({ notifyDaOrigin, buildDaCompletionMessage, activeDriverRuns });",
    {
      crypto: webcrypto, URL,
      // Exercise timeouts without five seconds of wall-clock delay per attempt.
      setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 5 : 0), clearTimeout,
      console: Object.fromEntries(["log", "warn", "error"].map((name) => [name, (...args) => logs.push(args)])),
      chrome: {
        tabs: {
          async sendMessage(tabId, envelope, options) {
            calls.push({ tabId, envelope, options });
            return send(envelope, options, calls.length);
          },
          get: async () => ({ url: currentUrl }),
        },
        runtime: { onMessage: { addListener(fn) { listener = fn; } } },
        action: { onClicked: { addListener() {} } },
      },
    },
  );
  return { ...api, calls, logs, receive: (msg, sender) => new Promise((resolve) => listener(msg, sender, resolve)) };
}

function page(pageOrigin = origin.pageOrigin) {
  let listener;
  const posts = [];
  vm.runInNewContext(content, {
    console: { log() {}, error() {} },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    window: {
      location: { origin: pageOrigin },
      postMessage(msg, target) { posts.push({ message: JSON.parse(JSON.stringify(msg)), target }); },
      addEventListener() {},
    },
  });
  return {
    posts,
    receive(msg) {
      let response;
      listener(msg, {}, (value) => { response = value; });
      return response;
    },
  };
}

test("48/48 completion is forwarded with the unchanged public payload and acknowledged", async () => {
  const app = page();
  const h = worker((envelope) => app.receive(envelope));
  assert.equal(await h.notifyDaOrigin(origin, message), true);
  assert.deepEqual(app.posts, [{ message, target: origin.pageOrigin }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.documentId, origin.documentId);
  assert.ok(h.logs.some(([line]) => String(line).includes("relayed to app tab 7")));
});

test("a lost acknowledgment retries without duplicate window messages", async () => {
  const app = page();
  const h = worker((envelope, _options, attempt) => {
    const ack = app.receive(envelope);
    if (attempt === 1) throw new Error("Response channel closed");
    return ack;
  });
  assert.equal(await h.notifyDaOrigin(origin, message), true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].envelope.notificationId, h.calls[1].envelope.notificationId);
  assert.equal(app.posts.length, 1);
});

test("a same-origin app reload falls back to its current top-frame document", async () => {
  const app = page();
  const h = worker((envelope, options) => {
    if (options.documentId) throw new Error("Document no longer exists");
    return app.receive(envelope);
  });
  assert.equal(await h.notifyDaOrigin(origin, message), true);
  assert.equal(h.calls[1].options.frameId, 0);
  assert.equal(h.calls[1].options.documentId, undefined);
  assert.equal(app.posts.length, 1);
});

test("navigation to a different origin does not receive a completion fallback", async () => {
  const h = worker(() => { throw new Error("Document no longer exists"); }, "https://unrelated.example/");
  assert.equal(await h.notifyDaOrigin(origin, message), false);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(({ options }) => options.documentId === origin.documentId));
  const app = page("https://unrelated.example");
  assert.equal(app.receive(h.calls[0].envelope).received, false);
  assert.equal(app.posts.length, 0);
});

test("an unresponsive content script has bounded retries and a clear delivery error", async () => {
  const h = worker(() => new Promise(() => {}));
  assert.equal(await h.notifyDaOrigin(origin, message), false);
  assert.equal(h.calls.length, 3);
  assert.ok(h.logs.some(([line]) => String(line).includes("final result could not be relayed")));
});

test("individual driver failures still produce completion, while unprocessed drivers produce failure", () => {
  const h = worker(() => ({ received: true }));
  const context = { period: "period" };
  const partial = h.buildDaCompletionMessage(context, message.payload.date, {
    totalDrivers: 48, submissionSummary: { successful: 47, failed: 1, notProcessed: 0 },
  });
  assert.equal(partial.type, "AMAZON_EXTRACTION_COMPLETE");
  assert.equal(partial.payload.failedDrivers, 1);
  const stopped = h.buildDaCompletionMessage(context, message.payload.date, {
    totalDrivers: 48, submissionSummary: { successful: 27, failed: 21, notProcessed: 21 },
  });
  assert.equal(stopped.type, "AMAZON_EXTRACTION_FAILED");
});

test("final handoff is rejected from another tab or while a submission is still running", async () => {
  const h = worker(() => ({ received: true }));
  let reports = 0;
  const run = { tabId: 42, flow: { type: message.payload.flowType }, inFlight: false,
    async reportResult() { reports++; } };
  h.activeDriverRuns.set("run", run);
  const finished = { type: "DA_EXTRACTION_FINISHED", runId: "run", result: {} };
  assert.equal((await h.receive(finished, { tab: { id: 99 } })).received, false);
  run.inFlight = true;
  assert.equal((await h.receive(finished, { tab: { id: 42 } })).received, false);
  run.inFlight = false;
  assert.equal((await h.receive(finished, { tab: { id: 42 } })).received, true);
  assert.equal(reports, 1);
});
