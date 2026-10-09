const FLOW_TYPE = "extract-da-itineraries-data";
const DEFAULT_BASE_URL =
  "https://logistics.amazon.com/operations/execution/dv/routes?navMenuVariant=external&provider=ALL_DRIVERS&selectedDay={date}&serviceAreaId={serviceAreaId}";
const SUBMIT_URL =
  "https://recon.amngtpro.com/api/functions/tsrAmazonReceiveDriver";
//const SUBMIT_URL = "https://candidate-dashboard-integration.free.beeceptor.com";

function buildUrl({ baseUrl, date, serviceAreaId }) {
  return baseUrl
    .replace("{date}", date)
    .replace("{serviceAreaId}", serviceAreaId);
}

async function extractDaItinerariesInPage(context) {
  // Testing limit per date: 0 = all drivers; set to 3 to process only the first 3.
  // Keep this inside the function because Chrome injects it without module scope.
  const MAX_DRIVERS = 100;
  const DRIVER_LIST_TIMEOUT_MS = 30000;
  const DRIVER_ROWS_TIMEOUT_MS = 30000;
  const RETURN_LIST_TIMEOUT_MS = 60000;
  const RETURN_LIST_ATTEMPTS = 3;
  const DIAGNOSTIC_VERSION = "da-return-list-recovery-v7";

  const result = {
    status: "DA itineraries page script started",
    url: window.location.href,
    date: context.date,
    serviceAreaId: context.serviceAreaId,
    ...(context.period !== undefined ? { period: context.period } : {}),
  };

  console.log(`[da-itineraries-page] Starting extraction for ${context.date}`);

  function findDAsButton(root = document) {
    const controlSelector =
      'button, [role="button"], [role="tab"], [role="radio"], label, a';

    function matchesDAs(label) {
      return /^DAs(?:\s*\/?\s*DPs)?(?:\s*\([\d,]+\))?$/i.test(
        (label || "").replace(/\s+/g, " ").trim(),
      );
    }

    function isAvailable(element) {
      const style = getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !element.matches(":disabled") &&
        !element.control?.disabled &&
        !element.closest('[aria-disabled="true"], [inert]')
      );
    }

    // Meridian exposes the visible option text in an aria-hidden span.
    // Match that label directly; the surrounding control may have extra text.
    for (const label of root.querySelectorAll("[data-mdn-button-option]")) {
      if (!matchesDAs(label.textContent) || !isAvailable(label)) {
        continue;
      }

      // Clicking the label itself also bubbles to non-semantic wrappers.
      const control = label.closest(controlSelector) || label;
      if (isAvailable(control)) {
        return control;
      }
    }

    return Array.from(root.querySelectorAll(controlSelector)).find(
      (element) => {
        const labels = [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
        ];
        return labels.some(matchesDAs) && isAvailable(element);
      },
    );
  }

  const driverRowSelector =
    '.meridian-itinerary-summary-list-item[class*="transporter-"], ' +
    '.meridian-itinerary-summary-list-item[class*="route-"]';

  function sleep(ms) {
    // DOM polling must not depend on an extension message channel staying open.
    // Actual driver submissions still await the background worker's API result.
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function readDriverRows(list) {
    return Array.from(list.querySelectorAll(driverRowSelector)).map((row) => {
      const classes = Array.from(row.classList);
      const transporterId = classes
        .find((name) => name.startsWith("transporter-"))
        ?.slice("transporter-".length);
      const itineraryId = classes
        .find((name) => name.startsWith("itinerary-"))
        ?.slice("itinerary-".length);
      const routeId = classes
        .find((name) => name.startsWith("route-"))
        ?.slice("route-".length);
      const texts = Array.from(row.querySelectorAll("p"), (node) =>
        normalizeText(node.textContent),
      );
      const indexValue = row
        .closest("[data-item-index]")
        ?.getAttribute("data-item-index");
      const index = indexValue == null ? null : Number(indexValue);
      return {
        key: transporterId
          ? `${transporterId}:${itineraryId || index}`
          : `route:${routeId}`,
        index,
        summary: {
          daProgress: {
            stops:
              texts.map((text) => parseProgress(text, "stops?")).find(Boolean) || null,
            deliveries:
              texts.map((text) => parseProgress(text, "deliver(?:y|ies)")).find(Boolean) || null,
          },
          appSignOut: texts
            .map((text) => text.match(/^App sign out:\s*(\d{1,2}:\d{2}\s*[ap]m)\b/i))
            .find(Boolean)?.[1] || null,
        },
        driver: {
          transporterId: transporterId || null,
          itineraryId: itineraryId || null,
          ...(routeId ? { routeId } : {}),
          driverName: normalizeText(
            row.querySelector('[data-testid="allow-text-selection-div"] p')
              ?.textContent,
          ),
        },
      };
    });
  }

  function isListContainerAvailable(list) {
    if (!list.isConnected) return false;
    // Readiness is based on DOM data, not a rendered rectangle. Exclude explicitly
    // hidden/stale panels while still allowing extraction in an inactive tab.
    for (let element = list; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (
        element.hidden ||
        element.hasAttribute("inert") ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        return false;
    }
    return true;
  }

  function isDriverListAvailable(list) {
    return isListContainerAvailable(list) && !!list.querySelector(driverRowSelector);
  }

  function isDriverRowReady({ driver, summary }) {
    return driver.driverName &&
      (driver.transporterId || (driver.routeId && summary.daProgress.deliveries));
  }

  function findDriverList() {
    return Array.from(
      document.querySelectorAll('[data-testid="virtuoso-item-list"]'),
    ).find(isDriverListAvailable);
  }

  function logDriverListDiagnostics(
    stage,
    visibilityChanges = [],
    rowReadiness,
  ) {
    const lists = Array.from(
      document.querySelectorAll('[data-testid="virtuoso-item-list"]'),
    );
    const rows = Array.from(document.querySelectorAll(driverRowSelector));
    function describe(element) {
      return {
        tag: element.tagName,
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("role"),
        className: element.getAttribute("class"),
        hasLayoutBox: element.getClientRects().length > 0,
      };
    }
    const diagnostics = {
      version: DIAGNOSTIC_VERSION,
      stage,
      timestamp: new Date().toISOString(),
      requestedDate: context.date,
      path: window.location.pathname,
      selectedDay: new URL(window.location.href).searchParams.get(
        "selectedDay",
      ),
      title: document.title,
      readyState: document.readyState,
      visibility: document.visibilityState,
      visibilityChanges,
      ...(rowReadiness ? { rowReadiness } : {}),
      listCount: lists.length,
      lists: lists.map((list) => ({
        ...describe(list),
        availableForExtraction: isDriverListAvailable(list),
        childCount: list.children.length,
        matchingDriverRows: list.querySelectorAll(driverRowSelector).length,
      })),
      matchingDriverRows: rows.length,
      driverRowsWithLayout: rows.filter(
        (row) => row.getClientRects().length > 0,
      ).length,
      transporterElements: document.querySelectorAll('[class*="transporter-"]')
        .length,
      otherListMarkers: Array.from(
        document.querySelectorAll('[data-testid*="virtuoso"]'),
      )
        .slice(0, 10)
        .map(describe),
      alerts: Array.from(document.querySelectorAll('[role="alert"]'))
        .slice(0, 3)
        .map((element) => normalizeText(element.textContent).slice(0, 500)),
    };
    // A JSON snapshot avoids DevTools showing a DOM node's later, changed state.
    // This is local debugging only; it is never included in driver API payloads.
    window.__ampDaListDiagnostics = diagnostics;
    console.log(
      "[da-itineraries-page] Driver list diagnostics:",
      JSON.stringify(diagnostics),
    );
  }

  async function waitForDriverList() {
    const startedAt = Date.now();
    const deadline = startedAt + DRIVER_LIST_TIMEOUT_MS;
    const visibilityChanges = [];
    let lastVisibility;
    while (true) {
      if (document.visibilityState !== lastVisibility) {
        lastVisibility = document.visibilityState;
        visibilityChanges.push({
          afterMs: Date.now() - startedAt,
          state: lastVisibility,
        });
      }
      const list = findDriverList();
      if (list) {
        return list;
      }
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    logDriverListDiagnostics("driver-list-timeout", visibilityChanges);
    throw new Error(
      `Driver list not found within ${DRIVER_LIST_TIMEOUT_MS / 1000} seconds after clicking DAs (page visibility: ${document.visibilityState}); see Driver list diagnostics`,
    );
  }

  function findScrollContainer(list) {
    for (
      let parent = list.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (
        /auto|scroll/.test(getComputedStyle(parent).overflowY) &&
        parent.scrollHeight > parent.clientHeight
      ) {
        return parent;
      }
    }
    const page = document.scrollingElement;
    return page?.scrollHeight > page?.clientHeight ? page : null;
  }

  async function waitForRenderedRows(list) {
    const startedAt = Date.now();
    const deadline = startedAt + DRIVER_ROWS_TIMEOUT_MS;
    let previous = "";
    let stableSince = startedAt;
    let identityChanges = 0;
    let polls = 0;
    let readiness;
    while (true) {
      if (!list.isConnected) {
        logDriverListDiagnostics("driver-list-replaced", [], readiness);
        throw new Error(
          "Driver list was replaced during extraction; run again",
        );
      }
      const rows = readDriverRows(list);
      // Names may hydrate independently. Only driver identities and positions
      // need to settle; the current names must still be present before returning.
      const signature = JSON.stringify(
        rows.map(({ key, index }) => [key, index]),
      );
      const readyRows = rows.filter(isDriverRowReady).length;
      const allRowsReady = rows.length > 0 && readyRows === rows.length;
      if (signature !== previous) {
        previous = signature;
        stableSince = Date.now();
        identityChanges += 1;
      }
      if (!allRowsReady) stableSince = Date.now();
      polls += 1;
      readiness = {
        elapsedMs: Date.now() - startedAt,
        polls,
        rowCount: rows.length,
        readyRows,
        identityChanges,
        stableForMs: Date.now() - stableSince,
        firstIndex: rows[0]?.index ?? null,
        lastIndex: rows[rows.length - 1]?.index ?? null,
      };
      // Inspect the latest snapshot before checking the deadline: a delayed
      // background polling response must not discard already-ready rows.
      if (allRowsReady && Date.now() - stableSince >= 750) return rows;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    logDriverListDiagnostics("driver-rows-timeout", [], readiness);
    throw new Error(
      `Driver rows did not finish rendering within ${DRIVER_ROWS_TIMEOUT_MS / 1000} seconds (${readiness.readyRows}/${readiness.rowCount} rows have a name and transporter or route ID); see Driver list diagnostics`,
    );
  }

  function findRoutePanel(transporterId) {
    return Array.from(document.querySelectorAll(".cortex-left-panel")).find(
      (panel) => {
        const breadcrumb = panel.querySelector("ol");
        const header = breadcrumb?.parentElement?.parentElement;
        return (
          panel.getClientRects().length > 0 &&
          panel.querySelector('button[aria-current="page"]') &&
          Array.from(header?.querySelectorAll("p") || []).some(
            (node) => normalizeText(node.textContent) === transporterId,
          )
        );
      },
    );
  }

  function parseProgress(text, label) {
    const match = normalizeText(text).match(
      new RegExp(`^([\\d,]+)\\s*/\\s*([\\d,]+)\\s*${label}$`, "i"),
    );
    if (!match) return null;
    const completed = Number(match[1].replace(/,/g, ""));
    const total = Number(match[2].replace(/,/g, ""));
    return { completed, total, text: `${completed}/${total}` };
  }

  function readRouteHeader(panel, entry) {
    const paragraphs = Array.from(panel.querySelectorAll("p"));
    const activities = findActivitiesControl(panel);
    const eventsRoot = activities?.getAttribute("aria-controls")
      ? document.getElementById(activities.getAttribute("aria-controls"))
      : activities?.parentElement;
    function readAppTime(nodes, label) {
      const pattern = new RegExp(
        `^App sign ${label}:\\s*(\\d{1,2}:\\d{2}\\s*[ap]m)\\b`,
        "i",
      );
      for (const node of nodes) {
        const match = normalizeText(node.textContent).match(pattern);
        if (match) return match[1];
      }
      return null;
    }
    const appSignIn = readAppTime(
      eventsRoot?.querySelectorAll("p") || [],
      "in",
    );
    const appSignOut = readAppTime(
      paragraphs.filter((node) => !eventsRoot?.contains(node)),
      "out",
    );
    const progressTitle = paragraphs.find(
      (node) => normalizeText(node.textContent) === "DA progress",
    );
    const progressTexts = Array.from(
      progressTitle?.parentElement.querySelectorAll("p") || [],
    ).map((node) => normalizeText(node.textContent));
    const stops = progressTexts
      .map((text) => parseProgress(text, "stops"))
      .find(Boolean);
    const deliveries = progressTexts
      .map((text) => parseProgress(text, "deliveries"))
      .find(Boolean);
    if (!stops || !deliveries) return null;

    const breaksTitle = paragraphs.find(
      (node) => normalizeText(node.textContent) === "Breaks taken",
    );
    const summary = normalizeText(
      breaksTitle?.parentElement.parentElement.textContent,
    ).replace(/^Breaks taken\s*/, "");
    const breakCount = summary.match(/^(\d+)\b/);
    const duration = summary.match(/\((.*?)\s+total\)/i);
    const breaks = paragraphs
      .filter((node) => /\bbreak\s+\d+$/i.test(normalizeText(node.textContent)))
      .map((node) => {
        const text = normalizeText(node.parentElement.textContent);
        const afterStop = text.match(/after stop\s*#(\d+)/i);
        const times = text.match(
          /(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)\s*\(([^)]+)\)/i,
        );
        return {
          label: normalizeText(node.textContent),
          afterStop: afterStop ? Number(afterStop[1]) : null,
          startTime: times?.[1] || null,
          endTime: times?.[2] || null,
          duration: times?.[3] || null,
        };
      });

    return {
      driverName: normalizeText(
        panel.querySelector('button[aria-current="page"]').textContent,
      ),
      transporterId: entry.driver.transporterId,
      itineraryId: entry.driver.itineraryId,
      appSignIn,
      appSignOut,
      daProgress: { stops, deliveries },
      breaksTaken: {
        count: breakCount ? Number(breakCount[1]) : null,
        totalDuration: duration?.[1] || null,
        items: breaks,
      },
    };
  }

  function readRouteStops(panel) {
    return Array.from(panel.querySelectorAll(".stops-list-item")).map((row) => {
      // Read only the stop heading; expanded package details can repeat counts.
      const heading = row.querySelector("[mdn-expander-title]");
      const paragraphs = Array.from(heading?.querySelectorAll("p") || []);
      const stopNumber = Number(normalizeText(paragraphs[0]?.textContent));
      if (!Number.isInteger(stopNumber) || stopNumber < 1) {
        throw new Error("A route stop is missing its number");
      }
      const routeLabel = heading.querySelector("p[title]");
      const details = paragraphs
        .slice(2)
        .filter((node) => node !== routeLabel)
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean)
        .join(" ");
      const planned = details.match(/\(Planned\s+([^)]+)\)/i);
      const summary = details.replace(/\s*\(Planned\s+[^)]+\)/gi, "").trim();
      const quantity = summary.match(
        /^([\d,]+)\s*\/\s*([\d,]+)\s*(pickups?|deliver(?:y|ies)|returns?)\b/i,
      );
      const time = summary.match(/\bat\s+(\d{1,2}:\d{2}\s*[ap]m)\b/i);
      return {
        stopNumber,
        address: normalizeText(paragraphs[1]?.textContent),
        routeCode: normalizeText(routeLabel?.textContent) || null,
        quantity: quantity
          ? `${quantity[1].replace(/,/g, "")}/${quantity[2].replace(/,/g, "")}`
          : null,
        type: quantity?.[3]?.toLowerCase() || null,
        time: time?.[1] || null,
        plannedTime: planned?.[1] || null,
        summary,
      };
    });
  }

  function findActivitiesControl(panel) {
    return Array.from(
      panel.querySelectorAll('[role="button"][aria-expanded]'),
    ).find(
      (node) =>
        normalizeText(
          node.querySelector("[mdn-expander-title]")?.textContent,
        ) === "DA events and activities",
    );
  }

  function logRouteDiagnostics(entry, readiness) {
    const diagnostics = {
      version: DIAGNOSTIC_VERSION,
      transporterId: entry.driver.transporterId,
      visibility: document.visibilityState,
      readiness,
      panels: Array.from(document.querySelectorAll(".cortex-left-panel")).map(
        (panel) => {
          const breadcrumb = panel.querySelector("ol");
          const header = breadcrumb?.parentElement?.parentElement;
          const texts = Array.from(panel.querySelectorAll("p")).map((node) =>
            normalizeText(node.textContent),
          );
          return {
            hasLayoutBox: panel.getClientRects().length > 0,
            currentDriver: normalizeText(
              panel.querySelector('button[aria-current="page"]')?.textContent,
            ),
            transporterInExpectedHeader: Array.from(
              header?.querySelectorAll("p") || [],
            ).some(
              (node) =>
                normalizeText(node.textContent) === entry.driver.transporterId,
            ),
            transporterElsewhereInPanel: texts.includes(
              entry.driver.transporterId,
            ),
            progressTexts: texts
              .filter((text) =>
                /^DA progress|^[\d,]+\s*\/\s*[\d,]+/i.test(text),
              )
              .slice(0, 12),
            activitiesExpanded:
              findActivitiesControl(panel)?.getAttribute("aria-expanded") ??
              null,
            stopRows: panel.querySelectorAll(".stops-list-item").length,
          };
        },
      ),
    };
    // Preserve each driver's failure locally even after navigating back to the list.
    window.__ampDaRouteDiagnostics ??= {};
    window.__ampDaRouteDiagnostics[entry.driver.transporterId] = diagnostics;
    console.error(
      "[da-itineraries-page] Route diagnostics:",
      JSON.stringify(diagnostics),
    );
  }

  async function waitForRouteSnapshot(entry) {
    const deadline = Date.now() + 15000;
    let previous = "";
    let stableSince = Date.now();
    const expandedControls = new Set();
    let readiness = "Route panel not matched to the requested transporter";
    while (true) {
      const panel = findRoutePanel(entry.driver.transporterId);
      const activities = panel && findActivitiesControl(panel);
      if (activities?.getAttribute("aria-expanded") === "false") {
        readiness = "DA events and activities section did not expand";
        if (!expandedControls.has(activities)) {
          activities.click();
          expandedControls.add(activities);
        }
        if (Date.now() >= deadline) break;
        await sleep(250);
        continue;
      }
      const header = panel && readRouteHeader(panel, entry);
      if (header) {
        const stops = readRouteStops(panel);
        readiness =
          stops.length || header.daProgress.stops.total === 0
            ? "Route data did not stabilize"
            : "DA progress loaded, but stop rows are missing";
        const signature = JSON.stringify({ header, stops });
        if (signature !== previous) {
          previous = signature;
          stableSince = Date.now();
        }
        if (
          (stops.length || header.daProgress.stops.total === 0) &&
          Date.now() - stableSince >= 750
        ) {
          return { panel, header, stops };
        }
      } else {
        readiness = panel
          ? "Route panel matched, but DA progress stops/deliveries could not be parsed"
          : "Route panel not matched to the requested transporter";
        previous = "";
        stableSince = Date.now();
      }
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    logRouteDiagnostics(entry, readiness);
    throw new Error(
      `Route details did not load for transporter ${entry.driver.transporterId}: ${readiness}; see Route diagnostics`,
    );
  }

  async function extractDriverRoute(entry) {
    let snapshot = await waitForRouteSnapshot(entry);
    const stopsByNumber = new Map();
    const totalStops = snapshot.header.daProgress.stops.total;
    // Most route pages render all stops at once. Scroll if only a subset exists.
    const scroller =
      snapshot.stops.length < totalStops
        ? findScrollContainer(snapshot.panel.querySelector(".stops-list-item"))
        : null;
    if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
    let previousEnd = "";
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      snapshot = await waitForRouteSnapshot(entry);
      for (const stop of snapshot.stops)
        stopsByNumber.set(stop.stopNumber, stop);
      if (stopsByNumber.size >= totalStops) break;
      const atBottom =
        !scroller ||
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atBottom) {
        const signature = `${stopsByNumber.size}:${scroller?.scrollHeight || 0}`;
        if (signature === previousEnd) break;
        previousEnd = signature;
      } else {
        previousEnd = "";
        scroller.scrollTo({
          top: scroller.scrollTop + Math.max(1, scroller.clientHeight * 0.75),
          behavior: "instant",
        });
      }
    }
    const stops = Array.from(stopsByNumber.values()).sort(
      (a, b) => a.stopNumber - b.stopNumber,
    );
    const complete =
      stops.length === totalStops &&
      stops.every((stop, index) => stop.stopNumber === index + 1);
    const route = { ...snapshot.header, stops, complete };
    console.log(
      `[da-itineraries-page] Route extracted: ${route.driverName}`,
      route,
    );
    if (!complete) {
      console.warn(
        `[da-itineraries-page] Partial route: collected ${stops.length} of ${totalStops} expected stops for ${route.driverName}`,
      );
    }
    return route;
  }

  async function waitForReturningDriverList(scrollTop) {
    const startedAt = Date.now();
    const deadline = startedAt + RETURN_LIST_TIMEOUT_MS;
    const resetLists = new WeakSet();
    let restoredPosition = false;
    let previousList = null;
    let previousSignature = "";
    let stableSince = startedAt;
    while (true) {
      // Amazon can replace the entire list during navigation. Never keep polling
      // a detached container, and require the new rows to settle before continuing.
      const list = findDriverList();
      if (list) {
        if (!restoredPosition) {
          const scroller = findScrollContainer(list);
          if (scroller) scroller.scrollTo({ top: scrollTop, behavior: "instant" });
          restoredPosition = true;
        }
        const rows = readDriverRows(list);
        const signature = JSON.stringify(rows.map(({ key, index }) => [key, index]));
        if (list !== previousList || signature !== previousSignature ||
            !rows.length || !rows.every(isDriverRowReady)) {
          stableSince = Date.now();
        }
        previousList = list;
        previousSignature = signature;
        if (rows.length && rows.every(isDriverRowReady) &&
            Date.now() - stableSince >= 750) return list;
      } else {
        previousList = null;
        stableSince = Date.now();
        const url = new URL(window.location.href);
        // Only nudge the summary view, never a driver's stop list or another date.
        if (Date.now() - startedAt >= 2000 &&
            url.pathname.replace(/\/$/, "").endsWith("/itineraries") &&
            url.searchParams.get("selectedDay") === context.date) {
          const emptyList = Array.from(document.querySelectorAll(
            '[data-testid="virtuoso-item-list"]',
          )).find((node) => isListContainerAvailable(node) &&
            node.children.length === 0 && !resetLists.has(node));
          if (emptyList) {
            // An empty virtual list may have no scrollable height yet. Find its
            // overflow container without requiring scrollHeight > clientHeight.
            let scroller = emptyList.parentElement;
            while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
              scroller = scroller.parentElement;
            }
            scroller ||= findScrollContainer(emptyList);
            if (scroller) {
              resetLists.add(emptyList);
              scroller.scrollTo({ top: 0, behavior: "instant" });
              scroller.dispatchEvent(new Event("scroll"));
              // Stay at the recovered position; locateDriverLink restores the
              // next driver's saved position when it searches for that driver.
              restoredPosition = true;
            }
          }
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    throw new Error("Driver list did not become ready within 60 seconds");
  }

  async function returnToDriverList(entry, scrollTop) {
    let lastError;
    for (let attempt = 1; attempt <= RETURN_LIST_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        console.warn(
          `[da-itineraries-page] Recovering driver list after ${entry.driver.driverName}: attempt ${attempt}/${RETURN_LIST_ATTEMPTS}`,
        );
      }
      try {
        const panel = findRoutePanel(entry.driver.transporterId);
        const back = findDAsButton(panel || document);
        // Avoid restarting an already-selected summary view while it hydrates.
        if (back && (panel || back.getAttribute("aria-selected") !== "true")) back.click();
        const list = await waitForReturningDriverList(scrollTop);
        if (attempt > 1) console.log("[da-itineraries-page] Driver list recovered; continuing with the next driver");
        return list;
      } catch (error) {
        lastError = error;
      }
    }
    logDriverListDiagnostics("return-list-recovery-exhausted");
    throw new Error(`Cannot recover driver list after ${RETURN_LIST_ATTEMPTS} attempts: ${lastError.message}`);
  }

  async function countDriverRoster() {
    const list = await waitForDriverList();
    await waitForRenderedRows(list);
    const scroller = findScrollContainer(list);
    const originalScrollTop = scroller?.scrollTop || 0;
    const entries = new Map();
    const indexes = new Set();
    let previousEnd = "";
    let reachedEnd = false;
    const deadline = Date.now() + 120000;
    try {
      if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
      while (Date.now() < deadline) {
        for (const entry of await waitForRenderedRows(list)) {
          if (
            !entry.driver.driverName ||
            !(entry.driver.transporterId || entry.driver.routeId)
          ) {
            throw new Error(
              "A driver row is missing its name or transporter/route ID",
            );
          }
          if (!entries.has(entry.key)) {
            entries.set(entry.key, {
              ...entry,
              scrollTop: scroller?.scrollTop || 0,
            });
          }
          if (Number.isInteger(entry.index)) indexes.add(entry.index);
        }
        const atBottom =
          !scroller ||
          scroller.scrollTop + scroller.clientHeight >=
            scroller.scrollHeight - 2;
        if (atBottom) {
          const signature = `${entries.size}:${scroller?.scrollHeight || 0}`;
          if (signature === previousEnd) {
            reachedEnd = true;
            break;
          }
          previousEnd = signature;
        } else {
          previousEnd = "";
          scroller.scrollTo({
            top: scroller.scrollTop + Math.max(1, scroller.clientHeight * 0.75),
            behavior: "instant",
          });
        }
      }
    } finally {
      if (scroller)
        scroller.scrollTo({ top: originalScrollTop, behavior: "instant" });
    }
    if (
      !reachedEnd ||
      (indexes.size > 0 && indexes.size !== Math.max(...indexes) + 1)
    ) {
      throw new Error(
        "Could not count the full driver list; no routes have been submitted",
      );
    }
    return {
      entries: Array.from(entries.values()).sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      ),
      originalScrollTop,
    };
  }

  async function locateDriverLink(entry) {
    const list = await waitForDriverList();
    const scroller = findScrollContainer(list);
    if (scroller)
      scroller.scrollTo({ top: entry.scrollTop, behavior: "instant" });
    let resetToTop = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await waitForRenderedRows(list);
      const row = Array.from(list.querySelectorAll(driverRowSelector)).find(
        (node) =>
          node.classList.contains(
            `transporter-${entry.driver.transporterId}`,
          ) &&
          (!entry.driver.itineraryId ||
            node.classList.contains(`itinerary-${entry.driver.itineraryId}`)),
      );
      const link = row?.querySelector("a.link-to-content-selectable");
      if (link) return { link, scrollTop: scroller?.scrollTop || 0 };
      if (!scroller) break;
      if (!resetToTop) {
        scroller.scrollTo({ top: 0, behavior: "instant" });
        resetToTop = true;
      } else if (
        scroller.scrollTop + scroller.clientHeight >=
        scroller.scrollHeight - 2
      ) {
        break;
      } else {
        scroller.scrollTo({
          top: scroller.scrollTop + Math.max(1, scroller.clientHeight * 0.75),
          behavior: "instant",
        });
      }
    }
    throw new Error(`Route link not found for ${entry.driver.driverName}`);
  }

  async function generateEmptyItineraryId(routeId) {
    // A stable synthetic ID keeps retries/repeated syncs tied to the same
    // planned route. Do not use the driver's name or processing order.
    const identity = JSON.stringify([context.serviceAreaId, context.date, routeId]);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identity),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Same 36-character / 8-4-4-4-12 shape, with an explicit synthetic prefix.
    return `empty000-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 24)}`;
  }

  async function collectDrivers() {
    console.log("[da-itineraries-page] Counting drivers...");
    const roster = await countDriverRoster();
    const selectedEntries =
      MAX_DRIVERS > 0 ? roster.entries.slice(0, MAX_DRIVERS) : roster.entries;
    const totalDrivers = selectedEntries.length;
    console.log(
      `[da-itineraries-page] Total drivers discovered: ${roster.entries.length}`,
    );
    if (MAX_DRIVERS > 0) {
      console.log(
        `[da-itineraries-page] Testing limit: processing ${totalDrivers} drivers (maximum ${MAX_DRIVERS})`,
      );
    }
    const submissionResults = [];

    for (const [index, entry] of selectedEntries.entries()) {
      const outcome = {
        ...entry.driver,
        driverNumber: index + 1,
        success: false,
        stage: "extraction",
        status: null,
      };
      let opened = false;
      let scrollTop = entry.scrollTop;
      let navigationError = null;
      try {
        console.log(
          `[da-itineraries-page] Driver ${index + 1}/${totalDrivers}: ${entry.driver.driverName}`,
        );
        let route;
        if (
          !entry.driver.transporterId && entry.driver.routeId &&
          entry.summary.daProgress.deliveries?.completed === 0
        ) {
          // Planned routes may have no assigned transporter/itinerary or detail
          // page yet. Preserve the known totals without inventing stop records.
          route = {
            ...entry.driver,
            transporterId: "",
            itineraryId: entry.driver.itineraryId ||
              await generateEmptyItineraryId(entry.driver.routeId),
            appSignIn: null,
            appSignOut: entry.summary.appSignOut,
            daProgress: entry.summary.daProgress,
            breaksTaken: { count: null, totalDuration: null, items: [] },
            stops: [],
            // Only summary data was available; this is not a full route extract.
            complete: false,
          };
          console.log(
            `[da-itineraries-page] Route extracted (summary only): ${route.driverName}`,
            route,
          );
        } else {
          const location = await locateDriverLink(entry);
          scrollTop = location.scrollTop;
          location.link.scrollIntoView({ block: "center", inline: "nearest" });
          location.link.click();
          opened = true;
          route = await extractDriverRoute(entry);
        }
        outcome.itineraryId = route.itineraryId;
        outcome.transporterId = route.transporterId;
        outcome.complete = route.complete;
        outcome.stage = "submission";
        // Await the background worker's HTTP result before opening another driver.
        const response = await chrome.runtime.sendMessage({
          type: "SUBMIT_DA_ROUTE",
          runId: context.runId,
          route,
          totalDrivers,
          driverNumber: index + 1,
        });
        outcome.success = response?.success === true;
        outcome.status = response?.status ?? null;
        if (!outcome.success)
          outcome.error =
            response?.error || "No API submission confirmation received";
      } catch (error) {
        outcome.error = error.message;
      } finally {
        submissionResults.push(outcome);
        if (outcome.success) {
          console.log(
            `[da-itineraries-page] Successfully sent ${entry.driver.driverName}: HTTP ${outcome.status}`,
          );
        } else {
          console.error(
            `[da-itineraries-page] Failed ${outcome.stage} for ${entry.driver.driverName}:`,
            outcome.error,
          );
        }
        if (opened && index + 1 < selectedEntries.length) {
          try {
            await returnToDriverList(entry, scrollTop);
          } catch (error) {
            navigationError = error;
          }
        }
      }
      if (navigationError) {
        console.error(
          "[da-itineraries-page] Cannot return to the driver list:",
          navigationError,
        );
        for (const [remainingIndex, remaining] of selectedEntries
          .slice(index + 1)
          .entries()) {
          submissionResults.push({
            ...remaining.driver,
            driverNumber: index + remainingIndex + 2,
            success: false,
            stage: "not_processed",
            status: null,
            error:
              "Not processed because navigation back to the driver list failed",
          });
        }
        break;
      }
    }

    const list = findDriverList();
    const scroller = list && findScrollContainer(list);
    if (scroller)
      scroller.scrollTo({ top: roster.originalScrollTop, behavior: "instant" });
    const successful = submissionResults.filter((item) => item.success).length;
    const submissionSummary = {
      successful,
      failed: totalDrivers - successful,
      submissionFailed: submissionResults.filter(
        (item) => !item.success && item.stage === "submission",
      ).length,
      extractionFailed: submissionResults.filter(
        (item) => item.stage === "extraction",
      ).length,
      notProcessed: submissionResults.filter(
        (item) => item.stage === "not_processed",
      ).length,
    };
    console.log(
      `[da-itineraries-page] Submission summary: ${successful} successfully sent, ${submissionSummary.submissionFailed} submission failures, ${submissionSummary.extractionFailed} extraction failures, ${submissionSummary.notProcessed} not processed (${totalDrivers} total drivers)`,
      submissionSummary,
    );
    return {
      totalDrivers,
      totalEntries: totalDrivers,
      submissionSummary,
      submissionResults,
      complete: submissionResults.every(
        (item) => item.success && item.complete,
      ),
    };
  }

  console.log("[da-itineraries-page] Waiting for the DAs button...");
  const deadline = Date.now() + 15000;
  let dasButton = findDAsButton();

  while (!dasButton && Date.now() < deadline) {
    await sleep(250);
    dasButton = findDAsButton();
  }

  if (!dasButton) {
    console.error(
      "[da-itineraries-page] DAs button not found or not enabled within 15 seconds",
    );
    throw new Error("DAs button not found or not enabled within 15 seconds");
  }

  dasButton.scrollIntoView({ block: "center", inline: "nearest" });
  dasButton.click();
  result.status = "DAs button clicked";
  console.log("[da-itineraries-page] DAs selected");
  try {
    Object.assign(result, await collectDrivers());
  } catch (error) {
    console.error(
      "[da-itineraries-page] Could not read the driver list:",
      error,
    );
    throw error;
  }
  result.status = result.complete
    ? "DA routes extracted and submitted"
    : "DA extraction/submission finished with incomplete results";
  return result;
}
function buildSubmission({ context, date, extractedData }) {
  const { route, totalDrivers, driverNumber } = extractedData || {};
  const isUnstartedSummary =
    route?.routeId && route.driverName &&
    route.transporterId === "" &&
    typeof route.itineraryId === "string" && route.itineraryId.trim() &&
    route.daProgress?.deliveries?.completed === 0 &&
    route.stops?.length === 0 && route.complete === false;
  if (
    (!route?.transporterId && !isUnstartedSummary) ||
    !Array.isArray(route?.stops)
  ) {
    throw new Error("DA itineraries submission requires one extracted route");
  }
  if (
    !Number.isInteger(totalDrivers) ||
    !Number.isInteger(driverNumber) ||
    driverNumber < 1 ||
    driverNumber > totalDrivers
  ) {
    throw new Error("Invalid driver submission number or total");
  }
  return {
    url: SUBMIT_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
    },
    body: {
      date,
      serviceAreaId: context.serviceAreaId,
      ...(context.period !== undefined ? { period: context.period } : {}),
      drivers: [route],
      driverNumber,
      totalDrivers,
      complete: route.complete === true,
    },
  };
}

export const daItinerariesFlow = {
  type: FLOW_TYPE,
  defaultBaseUrl: DEFAULT_BASE_URL,
  // Keep app-triggered DA tabs open for debugging. Set true to restore auto-close.
  // An explicit closeTab value in the app's payload overrides this default.
  closeTabByDefault: false,
  postLoadDelayMs: 6000,
  betweenDatesDelayMs: 3000,
  betweenSubmissionsDelayMs: 5000,
  maxSubmissionRetries: 3,
  submitPerDriver: true,
  matchesExpectedUrl: ({ currentUrl, date }) =>
    currentUrl.includes(`selectedDay=${date}`),
  buildUrl,
  extractInPage: extractDaItinerariesInPage,
  buildSubmission,
};
