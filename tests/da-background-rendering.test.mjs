import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const daType = "extract-da-itineraries-data";
const url = "https://logistics.amazon.com/operations/execution/itineraries?selectedDay=2026-10-01";

function harness({ attachFails = false, commandFails = false, extractFails = false, disableFails = false,
  handoff = false, neverReturns = false, detachAtEnd = false } = {}) {
  const calls = [];
  const listeners = new Set();
  let tabUrl = "about:blank";
  let runtimeListener;
  const chrome = {
    runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } }, getPlatformInfo: async () => ({}) },
    action: { onClicked: { addListener() {} } },
    debugger: {
      onDetach: {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
      },
      async attach(target, version) {
        calls.push(["attach", target, version]);
        if (attachFails) throw new Error("Already attached");
      },
      async sendCommand(target, method, params) {
        calls.push(["command", target, method, params]);
        if (commandFails && params.enabled) throw new Error("Command unavailable");
        if (disableFails && !params.enabled) throw new Error("Target closed");
      },
      async detach(target) { calls.push(["detach", target]); },
    },
    tabs: {
      async create(options) { calls.push(["create", options]); tabUrl = options.url; return { id: 42, url: tabUrl }; },
      async update(id, options) { calls.push(["update", id, options]); tabUrl = options.url; },
      async get(id) { return { id, status: "complete", url: tabUrl }; },
      async remove(id) { calls.push(["remove", id]); },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async executeScript(options) {
        calls.push(["extract", options.target]);
        if (extractFails) throw new Error("Extraction failed");
        if (handoff) {
          const ack = await new Promise((resolve) => runtimeListener({
            type: "DA_EXTRACTION_FINISHED", runId: options.args[0].runId,
            result: { totalDrivers: 48, submissionSummary: { successful: 48, failed: 0, notProcessed: 0 } },
          }, { tab: { id: 42 } }, resolve));
          assert.equal(ack.received, true);
        }
        if (detachAtEnd) {
          for (const listener of listeners) listener({ tabId: 42 }, "target_closed");
        }
        if (neverReturns) return new Promise(() => {});
        return [{ result: { complete: true } }];
      },
    },
  };
  const api = vm.runInNewContext(
    source.replace('import { FLOW_REGISTRY } from "./flows/index.js";', "const FLOW_REGISTRY = {};") +
      "\n;({ enableDaBackgroundRendering, executeFlowForDate, activeDriverRuns });",
    {
      chrome, crypto: webcrypto,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: (callback) => callback(),
      setInterval: () => 1,
      clearInterval: () => calls.push(["clearInterval"]),
    },
  );
  return {
    ...api, calls, listeners,
    run(type = daType, closeTab = false) {
      return api.executeFlowForDate(
        { type, buildUrl: () => url, submitPerDriver: type === daType, extractInPage() {} },
        { flowType: type, debugActiveTab: true, closeTab, serviceAreaId: "area" },
        "2026-10-01",
        async () => calls.push(["result"]),
      );
    },
  };
}

test("DA enables emulation before Amazon navigation and releases it after completion without activating tabs", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map((call) => call[0]))), [
    "create", "attach", "command", "update", "extract", "result", "clearInterval", "command", "detach",
  ]);
  const created = h.calls[0][1];
  assert.equal(created.url, "about:blank");
  assert.equal(created.active, false);
  const commands = h.calls.filter(([name]) => name === "command");
  assert.equal(commands[0][1].tabId, 42);
  assert.equal(commands[0][2], "Emulation.setFocusEmulationEnabled");
  assert.equal(commands[0][3].enabled, true);
  assert.equal(commands[1][3].enabled, false);
  const update = h.calls.find(([name]) => name === "update");
  assert.equal(update[1], 42);
  assert.equal(update[2].url, url);
  assert.equal("active" in update[2], false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.activeDriverRuns.size, 0);
});

test("explicit 48/48 handoff finishes and cleans up without executeScript returning", { timeout: 1000 }, async () => {
  const h = harness({ handoff: true, neverReturns: true });
  await h.run();
  assert.equal(h.calls.filter(([name]) => name === "result").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "detach").length, 1);
  assert.equal(h.activeDriverRuns.size, 0);
});

test("explicit handoff plus normal script return reports the result only once", async () => {
  const h = harness({ handoff: true });
  await h.run();
  assert.equal(h.calls.filter(([name]) => name === "result").length, 1);
});

test("late debugger detach cannot override a successfully returned extraction", async () => {
  const h = harness({ detachAtEnd: true });
  await h.run();
  assert.equal(h.calls.filter(([name]) => name === "result").length, 1);
});

test("extraction failure cleans up rendering before optional tab closure", async () => {
  const h = harness({ extractFails: true });
  await assert.rejects(h.run(daType, true), /Extraction failed/);
  assert.equal(h.calls.at(-2)[0], "detach");
  assert.equal(h.calls.at(-1)[0], "remove");
  assert.equal(h.listeners.size, 0);
  assert.equal(h.activeDriverRuns.size, 0);
});

test("unsupported emulation fails before navigation and detaches its own session", async () => {
  const h = harness({ commandFails: true });
  await assert.rejects(h.run(), /Could not enable DA background rendering: Command unavailable/);
  assert.ok(h.calls.some(([name]) => name === "detach"));
  assert.ok(!h.calls.some(([name]) => name === "update" || name === "extract"));
  assert.equal(h.listeners.size, 0);
});

test("attach failure does not detach another debugger session", async () => {
  const h = harness({ attachFails: true });
  await assert.rejects(h.run(), /Already attached/);
  assert.ok(!h.calls.some(([name]) => name === "detach"));
  assert.equal(h.listeners.size, 0);
});

test("session cancellation is reported without automatically reattaching", async () => {
  const h = harness();
  const session = await h.enableDaBackgroundRendering(42);
  for (const listener of h.listeners) listener({ tabId: 99 }, "target_closed");
  session.assertConnected();
  for (const listener of h.listeners) listener({ tabId: 42 }, "canceled_by_user");
  assert.throws(() => session.assertConnected(), /background rendering was interrupted/);
  await session.release();
  await session.release();
  assert.equal(h.calls.filter(([name]) => name === "attach").length, 1);
  assert.equal(h.calls.filter(([name]) => name === "detach").length, 0);
  assert.equal(h.listeners.size, 0);
});

test("cleanup still detaches if disabling emulation fails", async () => {
  const h = harness({ disableFails: true });
  await h.run();
  assert.equal(h.calls.at(-1)[0], "detach");
  assert.equal(h.listeners.size, 0);
});

for (const type of ["extract-route-assignments-data", "extract-weekly-schedule", "extract-work-summary-tool-data"]) {
  test(`${type} keeps its existing tab behavior without attaching a debugger`, async () => {
    const h = harness();
    await h.run(type);
    assert.equal(h.calls[0][1].url, url);
    assert.equal(h.calls[0][1].active, true);
    assert.ok(!h.calls.some(([name]) => ["attach", "command", "detach", "update"].includes(name)));
  });
}
