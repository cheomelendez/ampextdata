import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const daType = "extract-da-itineraries-data";

function harness(responses, flowType = daType, retries = 0) {
  const requests = [];
  let listener;
  const sandbox = {
    Response,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback) => callback(),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.ok(responses.length, "Unexpected additional API request");
      return responses.shift();
    },
    chrome: {
      runtime: { onMessage: { addListener: (callback) => { listener = callback; } } },
      action: { onClicked: { addListener() {} } },
    },
  };
  const { runs, submitBatches } = vm.runInNewContext(
    source.replace('import { FLOW_REGISTRY } from "./flows/index.js";', "const FLOW_REGISTRY = {};") +
      "\n;({ runs: activeDriverRuns, submitBatches });",
    sandbox,
  );
  const submission = { url: "https://example.test/driver", headers: {}, body: { drivers: [] } };
  const flow = {
    buildSubmission: () => submission,
    betweenSubmissionsDelayMs: 0,
    maxSubmissionRetries: retries,
  };
  const context = { flowType };
  runs.set("run", { flow, context, tabId: 42, date: "2026-10-01", nextSubmissionAt: 0 });
  return {
    requests,
    submit: () => new Promise((resolve) => {
      assert.equal(listener({ type: "SUBMIT_DA_ROUTE", runId: "run" }, { tab: { id: 42 } }, resolve), true);
    }),
    submitBatch: () => submitBatches(flow, context, [submission]),
  };
}

test("DA API validation response reaches the extraction tab via the existing failure message", async () => {
  const body = JSON.stringify({ error: "transporterId is required" });
  const { submit, requests } = harness([new Response(body, { status: 400 })]);
  const result = await submit();
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, `Batch 1/1 submission failed: HTTP 400; API response: ${body}`);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body, '{"drivers":[]}');
});

test("DA diagnostic handles empty and long non-JSON errors", async () => {
  const empty = await harness([new Response("", { status: 400 })]).submit();
  assert.equal(empty.error, "Batch 1/1 submission failed: HTTP 400");
  const long = await harness([new Response("x".repeat(6000), { status: 400 })]).submit();
  assert.ok(long.error.endsWith("… [truncated]"));
  assert.ok(long.error.length < 4200);
});

test("DA 429 retries and success confirmation remain unchanged", async () => {
  const { submit, requests } = harness([
    new Response("Rate limited", { status: 429, headers: { "Retry-After": "0" } }),
    new Response("OK", { status: 200 }),
  ], daType, 1);
  const result = await submit();
  assert.equal(result.success, true);
  assert.equal(result.status, 200);
  assert.equal(requests.length, 2);
});

test("other flows retain their existing error message", async () => {
  const { submitBatch } = harness([
    new Response("Server validation details", { status: 400 }),
  ], "extract-route-assignments-data");
  await assert.rejects(submitBatch(), {
    message: "Batch 1/1 submission failed: HTTP 400",
    status: 400,
  });
});
