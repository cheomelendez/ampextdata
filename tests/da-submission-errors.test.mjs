import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const daType = "extract-da-itineraries-data";

function harness(responses, flowType = daType, retries = 0, delayMs = 0) {
  const requests = [];
  const waits = [];
  let listener;
  const sandbox = {
    Response,
    AbortSignal,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, ms) => { waits.push(ms); callback(); },
    fetch: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      const { signal, ...request } = options;
      requests.push({ url, ...request });
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
    buildSubmission: ({ extractedData }) => extractedData.route ? {
      ...submission,
      body: {
        drivers: [extractedData.route],
        driverNumber: extractedData.driverNumber,
        totalDrivers: extractedData.totalDrivers,
      },
    } : submission,
    betweenSubmissionsDelayMs: delayMs,
    maxSubmissionRetries: retries,
  };
  const context = { flowType };
  runs.set("run", { flow, context, tabId: 42, date: "2026-10-01", nextSubmissionAt: 0 });
  return {
    requests,
    waits,
    submit: (driver = {}) => new Promise((resolve) => {
      assert.equal(listener({ type: "SUBMIT_DA_ROUTE", runId: "run", ...driver }, { tab: { id: 42 } }, resolve), true);
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

const rateLimit500 = (headers = {}) => new Response(
  JSON.stringify({ error: "Server error: Rate limit exceeded" }),
  { status: 500, headers },
);

test("DA HTTP 500 rate limit retries the identical driver before confirming success", async () => {
  const h = harness([rateLimit500(), new Response("OK", { status: 200 })], daType, 3, 5000);
  const result = await h.submit({
    route: { itineraryId: "route-27", driverName: "Driver 27", stops: [] },
    driverNumber: 27, totalDrivers: 50,
  });
  assert.equal(result.success, true);
  assert.deepEqual(h.waits, [5000]);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(JSON.parse(h.requests[1].body).driverNumber, 27);
});

test("DA retries HTTP 500 rate limits three times with backoff, then permits the next driver", async () => {
  const h = harness([
    rateLimit500(), rateLimit500(), rateLimit500(), rateLimit500(),
    new Response("OK", { status: 200 }),
  ], daType, 3, 5000);
  const result = await h.submit({ route: { itineraryId: "first" }, driverNumber: 1, totalDrivers: 2 });
  assert.equal(result.success, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /Rate limit exceeded/);
  assert.deepEqual(h.waits, [5000, 10000, 20000]);
  assert.equal(h.requests.length, 4);
  assert.equal(new Set(h.requests.map(({ body }) => body)).size, 1);
  const next = await h.submit({ route: { itineraryId: "second" }, driverNumber: 2, totalDrivers: 2 });
  assert.equal(next.success, true);
  assert.equal(h.requests.length, 5);
  assert.equal(JSON.parse(h.requests[4].body).driverNumber, 2);
});

test("DA HTTP 500 rate-limit retry respects Retry-After", async () => {
  const h = harness([
    rateLimit500({ "Retry-After": "12" }), new Response("OK", { status: 200 }),
  ], daType, 3, 5000);
  assert.equal((await h.submit()).success, true);
  assert.deepEqual(h.waits, [12000]);
});

test("ordinary DA HTTP 500 errors are not retried", async () => {
  const h = harness([new Response('{"error":"Database unavailable"}', { status: 500 })], daType, 3, 5000);
  assert.equal((await h.submit()).success, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.waits, []);
});

test("other flows do not retry HTTP 500 rate-limit messages", async () => {
  const h = harness([rateLimit500()], "extract-route-assignments-data", 3, 5000);
  await assert.rejects(h.submitBatch(), /HTTP 500/);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.waits, []);
});
