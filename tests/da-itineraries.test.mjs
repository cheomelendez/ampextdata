import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../flows/da-itineraries.js", import.meta.url), "utf8");
const { daItinerariesFlow: flow } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);
const context = { date: "2026-10-01", serviceAreaId: "area", period: "period", token: "test", runId: "run" };
const plain = (value) => JSON.parse(JSON.stringify(value));

// The supplied HTML's first card has a route-* class, no transporter/itinerary,
// and progress paragraphs containing 0/31 stops and 0/37 deliveries.
function row(index, classes, texts) {
  return {
    classList: classes.split(" "),
    closest: () => ({ getAttribute: () => String(index) }),
    querySelector: () => ({ textContent: texts[0] }),
    querySelectorAll: () => texts.map((textContent) => ({ textContent })),
  };
}
const plannedRow = () => row(0, "route-17766528-2 meridian-itinerary-summary-list-item", [
  "Planned Driver", "XL2", "Planned Departure Time: 11:00am", "0/31 stops", "0/37 deliveries",
]);
const assignedRow = () => row(1, "transporter-DRIVER2 itinerary-ITINERARY2 meridian-itinerary-summary-list-item", [
  "Assigned Driver", "CX1", "App sign out: 10:15pm", "83/84 stops", "122/123 deliveries",
]);

async function harness(rows, respond = () => ({ success: true, status: 200 }), overrides = {}, browser = {}) {
  let now = 0;
  const requests = [];
  const logs = [];
  const list = {
    isConnected: true,
    parentElement: null,
    hidden: false,
    hasAttribute: () => false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    get children() { return rows; },
    querySelectorAll(selector) {
      // Honor the production selector, including its transporter/route filter.
      return rows.filter((item) => selector.split(",").some((part) => {
        const prefix = part.match(/class\*="([^"]+)"/)?.[1];
        return item.classList.includes("meridian-itinerary-summary-list-item") &&
          (!prefix || item.classList.some((name) => name.includes(prefix)));
      }));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
  };
  // Expose the injected function's helpers without changing its production API.
  const injected = flow.extractInPage.toString().replace(
    '  console.log("[da-itineraries-page] Waiting for the DAs button...");',
    `  return { readDriverRows, readRouteHeader, countDriverRoster, collectDrivers, generateEmptyItineraryId,
      waitForReturningDriverList, returnToDriverList,
      useReturnControls(panel, button) {
        findRoutePanel = panel;
        findDAsButton = button;
      },
      useNavigation(locate, extract, back) {
        locateDriverLink = locate;
        extractDriverRoute = extract;
        if (back) returnToDriverList = back;
      }
    };
    console.log("[da-itineraries-page] Waiting for the DAs button...");`,
  );
  const helpers = await vm.runInNewContext(`(${injected})(context)`, {
    context: { ...context, ...overrides },
    crypto: webcrypto,
    TextEncoder,
    URL,
    Event,
    window: { location: { href: `https://example.test/operations/execution/itineraries?selectedDay=${context.date}` } },
    document: browser.document || {
      querySelectorAll: (selector) => selector.includes("virtuoso") ? [list] : [],
      scrollingElement: null,
      visibilityState: "hidden",
    },
    getComputedStyle: (node) => ({ display: "block", visibility: "visible", ...node.style }),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms) => { now += ms; browser.onSleep?.(now); callback(); },
    console: Object.fromEntries(["log", "warn", "error"].map((level) => [level, (...args) => logs.push({ level, args })])),
    chrome: { runtime: { async sendMessage(message) {
      requests.push(flow.buildSubmission({ context, date: context.date, extractedData: message }).body);
      return respond(message);
    } } },
  });
  return { helpers, requests, list, logs, elapsed: () => now };
}

test("counts the route-only first row alongside assigned drivers", async () => {
  const { helpers } = await harness([plannedRow(), assignedRow()]);
  const roster = plain(await helpers.countDriverRoster());
  assert.equal(roster.entries.length, 2);
  assert.deepEqual(roster.entries.map((entry) => entry.index), [0, 1]);
  assert.equal(roster.entries[0].driver.transporterId, null);
  assert.equal(roster.entries[0].driver.routeId, "17766528-2");
  assert.equal(roster.entries[1].driver.transporterId, "DRIVER2");
});

test("still rejects an actual gap in the roster", async () => {
  const { helpers } = await harness([assignedRow()]);
  await assert.rejects(helpers.countDriverRoster(), /Could not count the full driver list/);
});

for (const firstSuccess of [true, false]) {
  test(`submits the empty summary and continues to assigned route (first API success: ${firstSuccess})`, async () => {
    const { helpers, requests } = await harness([plannedRow(), assignedRow()], (message) => ({
      success: message.driverNumber === 1 ? firstSuccess : true,
      status: message.driverNumber === 1 && !firstSuccess ? 500 : 200,
    }));
    const navigation = [];
    const assignedRoute = {
      driverName: "Assigned Driver", transporterId: "DRIVER2", itineraryId: "ITINERARY2",
      stops: [{ stopNumber: 1, summary: "1/1 delivery" }], complete: true,
    };
    helpers.useNavigation(
      async (entry) => {
        navigation.push(entry.driver.transporterId);
        return { scrollTop: 0, link: { scrollIntoView() {}, click() {} } };
      },
      async () => assignedRoute,
      async () => navigation.push("back"),
    );
    const result = plain(await helpers.collectDrivers());
    // The final driver needs no return navigation to finish successfully.
    assert.deepEqual(navigation, ["DRIVER2"]);
    assert.equal(requests.length, 2);
    const payload = plain(requests[0]);
    assert.match(payload.drivers[0].itineraryId, /^empty000-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.equal(payload.drivers[0].itineraryId.length, 36);
    assert.deepEqual(payload, {
      date: context.date, serviceAreaId: context.serviceAreaId, period: context.period,
      drivers: [{
        transporterId: "", itineraryId: payload.drivers[0].itineraryId,
        routeId: "17766528-2", driverName: "Planned Driver",
        appSignIn: null, appSignOut: null,
        daProgress: {
          stops: { completed: 0, total: 31, text: "0/31" },
          deliveries: { completed: 0, total: 37, text: "0/37" },
        },
        breaksTaken: { count: null, totalDuration: null, items: [] },
        stops: [], complete: false,
      }],
      driverNumber: 1, totalDrivers: 2, complete: false,
    });
    assert.deepEqual(requests[1].drivers[0], assignedRoute);
    assert.equal(requests[1].driverNumber, 2);
    assert.equal(result.submissionSummary.successful, firstSuccess ? 2 : 1);
    assert.equal(result.submissionSummary.failed, firstSuccess ? 0 : 1);
    assert.equal(result.submissionSummary.notProcessed, 0);
  });
}

test("missing IDs alone do not qualify malformed data for submission", () => {
  for (const route of [
    { stops: [] },
    { driverName: "Missing", routeId: "route", transporterId: null, itineraryId: null,
      daProgress: { deliveries: { completed: 2 } }, stops: [], complete: false },
  ]) {
    assert.throws(() => flow.buildSubmission({
      context, date: context.date, extractedData: { route, driverNumber: 1, totalDrivers: 1 },
    }), /requires one extracted route/);
  }
});

test("generated IDs are stable across runs and distinct by route, date, and service area", async () => {
  const { helpers } = await harness([]);
  const id = await helpers.generateEmptyItineraryId("route-1");
  const anotherRun = await harness([], undefined, { runId: "another-run", period: "another-period" });
  assert.equal(await anotherRun.helpers.generateEmptyItineraryId("route-1"), id);
  const ids = await Promise.all(Array.from({ length: 1000 }, (_, index) =>
    helpers.generateEmptyItineraryId(`route-${index}`),
  ));
  assert.equal(new Set(ids).size, 1000);
  for (const overrides of [{ date: "2026-10-02" }, { serviceAreaId: "another-area" }]) {
    const other = await harness([], undefined, overrides);
    assert.notEqual(await other.helpers.generateEmptyItineraryId("route-1"), id);
  }
});

test("summary records preserve a real itinerary ID if one is already available", async () => {
  const item = plannedRow();
  item.classList.push("itinerary-existing-id");
  const { helpers, requests } = await harness([item]);
  await helpers.collectDrivers();
  assert.equal(requests[0].drivers[0].itineraryId, "existing-id");
});

test("return waits for delayed rows beyond the old 30-second cutoff in a hidden tab", async () => {
  const rows = [];
  const { helpers, elapsed } = await harness(rows, undefined, {}, {
    onSleep(now) { if (now >= 45000 && !rows.length) rows.push(assignedRow()); },
  });
  await helpers.waitForReturningDriverList(0);
  assert.ok(elapsed() >= 45750 && elapsed() < 60000);
});

test("empty virtual list is reset even without scrollable height", async () => {
  const rows = [];
  const { helpers, list } = await harness(rows);
  const events = [];
  list.parentElement = {
    parentElement: null,
    isConnected: true,
    hasAttribute: () => false,
    getAttribute: () => null,
    style: { overflowY: "auto" },
    scrollHeight: 400,
    clientHeight: 400,
    scrollTo({ top }) { events.push(top); },
    dispatchEvent(event) {
      events.push(event.type);
      rows.push(assignedRow());
    },
  };
  await helpers.waitForReturningDriverList(2000);
  assert.deepEqual(events, [0, "scroll"]);
});

test("return follows a replaced list and waits for its rows to settle", async () => {
  let currentList;
  let original;
  let replacement;
  const { helpers, list, elapsed } = await harness([assignedRow()], undefined, {}, {
    document: {
      querySelectorAll: () => [currentList],
      scrollingElement: null,
      visibilityState: "hidden",
    },
    onSleep(now) {
      if (now === 250) {
        original.isConnected = false;
        currentList = replacement;
      }
    },
  });
  original = list;
  replacement = { ...list };
  currentList = list;
  assert.equal(await helpers.waitForReturningDriverList(0), replacement);
  assert.ok(elapsed() >= 1000);
});

test("return retries a navigation that did not switch to the summary view", async () => {
  const rows = [];
  const { helpers, elapsed } = await harness(rows);
  let clicks = 0;
  helpers.useReturnControls(() => ({}), () => ({
    getAttribute: () => "false",
    click() { if (++clicks === 2) rows.push(assignedRow()); },
  }));
  await helpers.returnToDriverList({ driver: { driverName: "Driver", transporterId: "D" } }, 0);
  assert.equal(clicks, 2);
  assert.ok(elapsed() >= 60000 && elapsed() < 120000);
});

function assignedRows(count) {
  return Array.from({ length: count }, (_, index) => row(index,
    `transporter-D${index} itinerary-I${index} meridian-itinerary-summary-list-item`,
    [`Driver ${index + 1}`, "1/1 stops", "1/1 deliveries"],
  ));
}

test("48-driver run recovers after driver 27 without repeating any submissions", async () => {
  const roster = assignedRows(48);
  const rows = [...roster];
  let stalledAt = null;
  let currentDriver;
  let detailOpen = false;
  const run = await harness(rows, undefined, {}, {
    onSleep(now) {
      if (stalledAt !== null && now - stalledAt >= 65000 && !rows.length) rows.push(...roster);
    },
  });
  run.helpers.useNavigation(
    async (entry) => ({ scrollTop: 0, link: {
      scrollIntoView() {},
      click() { currentDriver = entry.driver; detailOpen = true; },
    } }),
    async (entry) => ({ ...entry.driver, stops: [], complete: true }),
  );
  run.helpers.useReturnControls(() => detailOpen ? {} : null, () => ({
    getAttribute: () => detailOpen ? "false" : "true",
    click() {
      detailOpen = false;
      if (currentDriver.transporterId === "D26") {
        rows.length = 0;
        stalledAt = run.elapsed();
      }
    },
  }));
  const result = await run.helpers.collectDrivers();
  assert.equal(run.requests.length, 48);
  assert.deepEqual(run.requests.map((payload) => payload.driverNumber), Array.from({ length: 48 }, (_, index) => index + 1));
  assert.equal(new Set(run.requests.map((payload) => payload.drivers[0].itineraryId)).size, 48);
  assert.equal(result.submissionSummary.successful, 48);
  assert.equal(result.submissionSummary.notProcessed, 0);
  assert.ok(run.logs.some(({ args }) => String(args[0]).includes("Driver list recovered")));
});

test("exhausted recovery stops within its budget and labels remaining drivers unprocessed", async () => {
  const rows = assignedRows(3);
  const run = await harness(rows);
  run.helpers.useNavigation(
    async () => ({ scrollTop: 0, link: { scrollIntoView() {}, click() {} } }),
    async (entry) => ({ ...entry.driver, stops: [], complete: true }),
  );
  run.helpers.useReturnControls(() => null, () => ({
    getAttribute: () => "false",
    click() { rows.length = 0; },
  }));
  const result = await run.helpers.collectDrivers();
  assert.equal(run.requests.length, 1);
  assert.equal(result.submissionSummary.successful, 1);
  assert.equal(result.submissionSummary.submissionFailed, 0);
  assert.equal(result.submissionSummary.extractionFailed, 0);
  assert.equal(result.submissionSummary.notProcessed, 2);
  assert.ok(run.elapsed() >= 180000 && run.elapsed() < 185000);
  assert.ok(run.logs.some(({ args }) => String(args[0]).includes(
    "1 successfully sent, 0 submission failures, 0 extraction failures, 2 not processed",
  )));
});

function routePanelWithBreaks(labels) {
  const progress = ["DA progress", "10/10 stops", "20/20 deliveries"]
    .map((textContent) => ({ textContent }));
  progress[0].parentElement = { querySelectorAll: () => progress };
  const breaksTitle = {
    textContent: "Breaks taken",
    parentElement: { parentElement: { textContent: `Breaks taken ${labels.length} (${labels.length * 10}m total)` } },
  };
  const details = labels.map((textContent, index) => ({
    textContent,
    parentElement: {
      textContent: `${textContent} (after stop #${index + 2}) ${index + 1}:18pm - ${index + 1}:28pm (10m)`,
    },
  }));
  const paragraphs = [...progress, breaksTitle, ...details,
    // Summary/help/event text must not become an additional break detail.
    { textContent: "Includes 30m of paid rest breaks and 30m of unpaid meal breaks" },
    { textContent: "Heat break taken at 1:18pm (10min)" },
  ];
  return {
    querySelectorAll: (selector) => selector === "p" ? paragraphs : [],
    querySelector: () => ({ textContent: "Driver" }),
  };
}

for (const label of ["Break", "Heat break", "Rest break", "Meal break", "Heat break 1"]) {
  test(`single break detail is included for label "${label}"`, async () => {
    const { helpers } = await harness([]);
    const header = plain(helpers.readRouteHeader(routePanelWithBreaks([label]), {
      driver: { transporterId: "D", itineraryId: "I" },
    }));
    assert.deepEqual(header.breaksTaken, {
      count: 1,
      totalDuration: "10m",
      items: [{ label, afterStop: 2, startTime: "1:18pm", endTime: "1:28pm", duration: "10m" }],
    });
  });
}

test("multiple numbered breaks retain their individual times and stop numbers", async () => {
  const { helpers } = await harness([]);
  const header = plain(helpers.readRouteHeader(routePanelWithBreaks(["Heat break 1", "Heat break 2"]), {
    driver: { transporterId: "D", itineraryId: "I" },
  }));
  assert.deepEqual(header.breaksTaken, {
    count: 2,
    totalDuration: "20m",
    items: [
      { label: "Heat break 1", afterStop: 2, startTime: "1:18pm", endTime: "1:28pm", duration: "10m" },
      { label: "Heat break 2", afterStop: 3, startTime: "2:18pm", endTime: "2:28pm", duration: "10m" },
    ],
  });
});

test("zero breaks does not create a placeholder detail", async () => {
  const { helpers } = await harness([]);
  const header = plain(helpers.readRouteHeader(routePanelWithBreaks([]), { driver: {} }));
  assert.deepEqual(header.breaksTaken, { count: 0, totalDuration: "0m", items: [] });
});
