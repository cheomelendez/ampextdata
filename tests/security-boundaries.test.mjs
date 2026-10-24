import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { FLOW_REGISTRY } from "../flows/index.js";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const appOrigin = "https://recon.amngtpro.com";
const daType = "extract-da-itineraries-data";
const payload = {
  flowType: daType, dates: ["2026-10-01"], serviceAreaId: "area",
  token: "private-api-token", period: "period",
};

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const fn of listeners) fn(...args); },
  };
}

function worker(overrides = {}) {
  const logs = [];
  const requests = [];
  const navigations = [];
  const timers = new Map();
  const cleared = [];
  let timerId = 0;
  const chrome = {
    runtime: { id: "extension", onMessage: event() },
    action: { onClicked: event() },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      get: async () => ({ status: "complete", url: "https://logistics.amazon.com/signin" }),
      update: async (id, options) => navigations.push({ id, ...options }),
      sendMessage: async () => ({ received: true }),
    },
  };
  const api = vm.runInNewContext(
    background.replace('import { FLOW_REGISTRY } from "./flows/index.js";', "") + `
      ;({ buildFlowContext, matchesAmazonFlowUrl, ensureExpectedTabUrl,
        waitForTabComplete, submitFlowResult, sendSubmission, runExtraction,
        activeExtractionKeys,
        useExecutor(fn) { executeFlowForDate = fn; },
      });`,
    {
      FLOW_REGISTRY, chrome, URL, URLSearchParams, Date, AbortSignal, crypto: webcrypto,
      console: Object.fromEntries(["log", "warn", "error"].map((key) => [key, (...args) => logs.push(args)])),
      setTimeout(fn, ms) {
        const id = ++timerId;
        if (ms === 90000 || ms === 5000) timers.set(id, fn);
        else queueMicrotask(fn);
        return id;
      },
      clearTimeout(id) { cleared.push(id); timers.delete(id); },
      fetch: async (url, options) => {
        requests.push({ url, ...options });
        return new Response("OK", { status: 200 });
      },
      ...overrides,
    },
  );
  return { ...api, chrome, logs, requests, navigations, timers, cleared };
}

function page(origin = appOrigin) {
  const relayed = [];
  let listener;
  const window = { location: { origin }, addEventListener(_type, fn) { listener = fn; } };
  vm.runInNewContext(content, {
    window, console: { log() {}, error() {} },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(message) { relayed.push(message); },
    } },
  });
  return {
    window, relayed,
    send(changes = {}) {
      listener({ source: window, origin, data: { type: "START_AMAZON_EXTRACTION", payload }, ...changes });
    },
  };
}

test("page bridge accepts the app's own message and rejects foreign origins/frames", () => {
  const h = page();
  h.send({ origin: "https://untrusted.example" });
  h.send({ source: {} });
  assert.equal(h.relayed.length, 0);
  h.send();
  assert.equal(h.relayed.length, 1);
  assert.equal(h.relayed[0].payload.token, payload.token);
  const other = page("https://untrusted.example");
  other.send();
  assert.equal(other.relayed.length, 0);
});

test("worker independently authorizes the extension, app origin, URL and top frame", async () => {
  const h = worker();
  const executions = [];
  h.useExecutor(async (...args) => executions.push(args));
  const receive = [...h.chrome.runtime.onMessage.listeners][0];
  const sender = { id: "extension", tab: { id: 7 }, frameId: 0, origin: appOrigin, url: `${appOrigin}/sync` };
  for (const changes of [
    { origin: "https://evil.example" }, { url: "https://evil.example" },
    { origin: "null" }, { id: "other-extension" }, { frameId: 1 },
    { tab: undefined }, { url: undefined },
  ]) {
    let ack;
    receive({ type: "START_AMAZON_EXTRACTION", payload }, { ...sender, ...changes }, (value) => { ack = value; });
    assert.equal(ack.accepted, false);
  }
  assert.equal(executions.length, 0);
  let ack;
  receive({ type: "START_AMAZON_EXTRACTION", payload }, sender, (value) => { ack = value; });
  await new Promise(setImmediate);
  assert.equal(ack.accepted, true);
  assert.equal(executions.length, 1);
  assert.equal(executions[0][1].token, payload.token);
  assert.equal(h.chrome.action.onClicked.listeners.size, 0, "No manual extraction handler");
});

test("each existing flow's default URL and payload are accepted", () => {
  const h = worker();
  for (const flow of Object.values(FLOW_REGISTRY)) {
    const { context } = h.buildFlowContext({ ...payload, flowType: flow.type });
    const url = flow.buildUrl({ ...context, date: context.dates[0] });
    assert.equal(h.matchesAmazonFlowUrl(url, flow.type, context.dates[0], "area"), true);
    assert.equal(context.token, payload.token);
  }
});

test("invalid types, dates, IDs, tokens, inherited flow names and debug options are rejected", () => {
  const h = worker();
  for (const change of [
    { dates: "2026-10-01" }, { dates: [] }, { dates: ["2026-02-30"] },
    { dates: Array(367).fill("2026-10-01") }, { dates: ["2026-10-01", "2026-10-01"] },
    { token: {} }, { token: "" }, { token: "x\r\nInjected: yes" },
    { serviceAreaId: {} }, { serviceAreaId: "area&selectedDay=other" },
    { period: {} }, { flowType: "toString" }, { flowType: "__proto__" },
    { closeTab: "false" }, { debugActiveTab: 1 }, { keepTabOpenMs: -1 }, { keepTabOpenMs: 60001 },
  ]) assert.throws(() => h.buildFlowContext({ ...payload, ...change }), JSON.stringify(change));
  for (const value of [null, [], "request"]) assert.throws(() => h.buildFlowContext(value));
});

test("request URL must match HTTPS Amazon origin, approved path, exact date and area", () => {
  const h = worker();
  const valid = FLOW_REGISTRY[daType].buildUrl({
    baseUrl: FLOW_REGISTRY[daType].defaultBaseUrl, date: "2026-10-01", serviceAreaId: "area",
  });
  for (const url of [
    valid.replace("https:", "http:"), valid.replace("logistics.amazon.com", "logistics.amazon.com.evil.example"),
    valid.replace("logistics.amazon.com", "user:password@logistics.amazon.com"),
    valid.replace("/operations/execution/dv/routes", "/unrelated"),
    valid.replace("2026-10-01", "2026-10-010"), valid.replace("serviceAreaId=area", "serviceAreaId=other"),
    `${valid}&selectedDay=2026-10-01`, `${valid}&serviceAreaId=area`,
  ]) assert.throws(() => h.buildFlowContext({ ...payload, baseUrl: url }), url);
  assert.equal(h.matchesAmazonFlowUrl(
    "https://logistics.amazon.com/operations/execution/itineraries?selectedDay=2026-10-01",
    daType, "2026-10-01", "area", true,
  ), true, "Known Amazon redirect may omit area");
});

test("persistent login/wrong-page redirects fail before extraction after two navigations", async () => {
  const h = worker();
  await assert.rejects(h.ensureExpectedTabUrl(FLOW_REGISTRY[daType], payload, 42,
    FLOW_REGISTRY[daType].defaultBaseUrl, "2026-10-01"), /Sign in to Amazon Logistics separately/);
  assert.equal(h.navigations.length, 2);
  assert.equal(h.timers.size, 0);
});

test("tab load wait releases listeners and timeout on completion", async () => {
  const h = worker();
  await h.waitForTabComplete(42);
  assert.equal(h.chrome.tabs.onUpdated.listeners.size, 0);
  assert.equal(h.chrome.tabs.onRemoved.listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

for (const trigger of ["timeout", "closed"]) {
  test(`tab load fails and cleans up when ${trigger}`, async () => {
    const h = worker();
    h.chrome.tabs.get = async () => ({ status: "loading" });
    const pending = h.waitForTabComplete(42);
    if (trigger === "closed") h.chrome.tabs.onRemoved.emit(42);
    else [...h.timers.values()][0]();
    await assert.rejects(pending, /closed|90 seconds/);
    assert.equal(h.chrome.tabs.onUpdated.listeners.size, 0);
    assert.equal(h.chrome.tabs.onRemoved.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  });
}

test("duplicate starts do not extract twice or report a spurious failure; locks release", async () => {
  const h = worker();
  let finish;
  let executions = 0;
  h.useExecutor(() => { executions++; return new Promise((resolve) => { finish = resolve; }); });
  const first = h.runExtraction(payload);
  await h.runExtraction({ ...payload, token: "refreshed-token" });
  assert.equal(executions, 1);
  assert.equal(h.logs.length, 0);
  finish();
  await first;
  assert.equal(h.activeExtractionKeys.size, 0);
  h.useExecutor(async () => { throw new Error("Mock failure"); });
  await h.runExtraction(payload);
  assert.equal(h.activeExtractionKeys.size, 0);
});

test("different concurrent runs are refused without disturbing the current run", async () => {
  const h = worker();
  let finish;
  let executions = 0;
  h.useExecutor(() => { executions++; return new Promise((resolve) => { finish = resolve; }); });
  const first = h.runExtraction(payload);
  await h.runExtraction({ ...payload, dates: ["2026-10-02"] });
  assert.equal(executions, 1);
  assert.equal(h.activeExtractionKeys.size, 1);
  finish();
  await first;
  assert.equal(h.activeExtractionKeys.size, 0);
});

for (const status of [400, 401, 500]) {
  test(`non-DA HTTP ${status} is a failure, without logging response contents`, async () => {
    const h = worker({ fetch: async () => new Response("private-server-response", { status }) });
    const flow = FLOW_REGISTRY["extract-route-assignments-data"];
    await assert.rejects(h.submitFlowResult(flow, { ...payload, flowType: flow.type }, {
      date: "2026-10-01", extractedData: [{ private: "private-driver-record" }],
    }), new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(h.logs), /private-/);
  });
}

test("bearer credential remains in HTTPS API header; records and response bodies are not logged", async () => {
  const h = worker();
  const flow = FLOW_REGISTRY["extract-route-assignments-data"];
  await h.submitFlowResult(flow, { ...payload, flowType: flow.type }, {
    date: "2026-10-01", extractedData: [{ name: "private-driver-record" }],
  });
  assert.equal(h.requests[0].headers.Authorization, `Bearer ${payload.token}`);
  assert.match(h.requests[0].url, /^https:\/\/recon\.amngtpro\.com\//);
  assert.ok(h.requests[0].signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(h.logs), /private-/);
});

test("network deadline aborts a stalled response body without automatically resubmitting", async () => {
  const controller = new AbortController();
  let requests = 0;
  const h = worker({
    AbortSignal: { timeout(ms) { assert.equal(ms, 60000); return controller.signal; } },
    fetch: async (_url, { signal }) => {
      requests++;
      return { text: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Request timed out")), { once: true });
      }) };
    },
  });
  const pending = h.sendSubmission(payload, { url: "https://example.test", body: {} });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, /timed out/);
  assert.equal(requests, 1);
});

test("manifest grants the bridge only to the confirmed app and excludes the mock receiver", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].matches, [`${appOrigin}/*`]);
  assert.deepEqual(manifest.host_permissions, ["https://logistics.amazon.com/*", `${appOrigin}/*`]);
  assert.ok(manifest.permissions.includes("debugger"));
});
