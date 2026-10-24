import { FLOW_REGISTRY } from "./flows/index.js";

const DEFAULT_FLOW_TYPE = "extract-route-assignments-data";
const TRUSTED_APP_ORIGIN = "https://recon.amngtpro.com";
const activeDriverRuns = new Map();
const activeExtractionKeys = new Set();
// Keep the DA API's rejection reason after the response body has been read.
const daSubmissionErrors = new WeakMap();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let timeout;
    function finish(error) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    }
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        finish();
      }
    }
    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish(new Error("Extraction tab was closed while loading"));
    }
    timeout = setTimeout(() => finish(new Error("Amazon page did not finish loading within 90 seconds")), 90000);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // The tab may have finished loading before the listener was attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          finish();
        }
      })
      .catch(() => {
        finish(new Error("Extraction tab is no longer available"));
      });
  });
}

async function ensureExpectedTabUrl(flow, context, tabId, expectedUrl, date) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = currentTab.url || "";

    if (matchesAmazonFlowUrl(currentUrl, context.flowType, date, context.serviceAreaId, true)) {
      return;
    }
    if (attempt === 2) break;

    await chrome.tabs.update(tabId, { url: expectedUrl });
    await waitForTabComplete(tabId);
    await sleep(2000);
  }
  throw new Error("Amazon did not load the requested flow/date. Sign in to Amazon Logistics separately, then retry the sync.");
}

// The app supplies configuration, not arbitrary navigation authority. Amazon
// redirects DA routes to itineraries and may omit serviceAreaId on that redirect.
function matchesAmazonFlowUrl(value, flowType, date, serviceAreaId, allowRedirect = false) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://logistics.amazon.com" || url.username || url.password) return false;
    const path = url.pathname.replace(/\/$/, "");
    let params = url.searchParams;
    let dateKey = "date";
    if (flowType === "extract-da-itineraries-data") {
      if (!/^\/operations\/execution\/(?:dv\/)?(?:routes|itineraries)$/.test(path) || url.hash) return false;
      dateKey = "selectedDay";
    } else if (flowType === "extract-route-assignments-data") {
      if (path !== "/scheduling" || url.hash) return false;
    } else if (flowType === "extract-weekly-schedule") {
      if (path !== "/scheduling/calendar-view/week" || url.hash) return false;
    } else if (flowType === "extract-work-summary-tool-data") {
      if (path !== "/harmony/v2" || !url.hash.startsWith("#!/dsp-portal?")) return false;
      params = new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1));
      dateKey = "localDate";
    } else return false;
    if (params.getAll(dateKey).length !== 1 || params.get(dateKey) !== date) return false;
    const areas = params.getAll("serviceAreaId");
    return (allowRedirect && areas.length === 0) ||
      (areas.length === 1 && areas[0] === serviceAreaId);
  } catch { return false; }
}

function buildFlowContext(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Extraction payload must be an object");
  }
  const flowType = payload.flowType || DEFAULT_FLOW_TYPE;
  if (typeof flowType !== "string" || !Object.hasOwn(FLOW_REGISTRY, flowType))
    throw new Error("Unsupported flow type");
  const flow = FLOW_REGISTRY[flowType];

  const context = {
    flowType,
    baseUrl: payload.baseUrl ?? flow.defaultBaseUrl,
    dates: payload.dates,
    serviceAreaId: payload.serviceAreaId,
    token: payload.token,
    ...(payload.period !== undefined ? { period: payload.period } : {}),
    ...(payload.debugActiveTab !== undefined ? { debugActiveTab: payload.debugActiveTab } : {}),
    ...(payload.closeTab !== undefined ? { closeTab: payload.closeTab } : {}),
    ...(payload.keepTabOpenMs !== undefined ? { keepTabOpenMs: payload.keepTabOpenMs } : {}),
  };
  if (!Array.isArray(context.dates) || context.dates.length < 1 || context.dates.length > 366 ||
      !context.dates.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) ||
      new Set(context.dates).size !== context.dates.length)
    throw new Error("Provide 1–366 distinct dates in YYYY-MM-DD format");
  if (typeof context.serviceAreaId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(context.serviceAreaId))
    throw new Error("Invalid service area ID");
  if (typeof context.token !== "string" || !/^[\x21-\x7E]{1,16384}$/.test(context.token))
    throw new Error("A nonempty API token is required");
  if (context.period !== undefined &&
      (typeof context.period !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(context.period)))
    throw new Error("Invalid period ID");
  for (const option of ["debugActiveTab", "closeTab"])
    if (context[option] !== undefined && typeof context[option] !== "boolean")
      throw new Error("Debug tab options must be booleans");
  if (context.keepTabOpenMs !== undefined &&
      (!Number.isInteger(context.keepTabOpenMs) || context.keepTabOpenMs < 0 || context.keepTabOpenMs > 60000))
    throw new Error("Debug tab delay must be between 0 and 60000 milliseconds");
  if (typeof context.baseUrl !== "string" || context.baseUrl.length > 4096 ||
      !context.dates.every((date) => matchesAmazonFlowUrl(flow.buildUrl({
        baseUrl: context.baseUrl, date, serviceAreaId: context.serviceAreaId,
      }), flowType, date, context.serviceAreaId)))
    throw new Error("The extraction URL must match the approved Amazon flow, date, and service area");
  context.dates = [...context.dates];

  return { flow, context };
}

async function enableDaBackgroundRendering(tabId) {
  if (!chrome.debugger) {
    throw new Error(
      "DA background rendering requires the debugger permission. Reload the updated extension.",
    );
  }
  const target = { tabId };
  let attached = false;
  let interrupted = null;
  let released = false;
  function onDetach(source, reason) {
    if (source.tabId !== tabId || released) return;
    attached = false;
    interrupted = new Error(
      `DA background rendering was interrupted (${reason}). Keep Chrome's debugging session running until extraction finishes.`,
    );
  }
  async function release() {
    if (released) return;
    released = true;
    chrome.debugger.onDetach.removeListener(onDetach);
    if (!attached) return;
    try {
      await chrome.debugger.sendCommand(
        target,
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
      );
    } catch {
      console.warn("Could not clear focus emulation; detaching the rendering session.");
    } finally {
      try {
        await chrome.debugger.detach(target);
      } catch {
        console.warn("Rendering session is no longer available for cleanup.");
      }
      attached = false;
    }
  }
  chrome.debugger.onDetach.addListener(onDetach);
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    // Browser-level emulation keeps visibility-dependent rendering running.
    // It does not activate the tab or focus its window. Chrome shows a debugging
    // banner while attached; this is not a completely invisible execution mode.
    await chrome.debugger.sendCommand(
      target,
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    );
    if (interrupted) throw interrupted;
    return {
      release,
      assertConnected() {
        if (interrupted) throw interrupted;
      },
    };
  } catch (error) {
    await release();
    throw new Error(
      `Could not enable DA background rendering: ${error.message}`,
    );
  }
}

async function executeFlowForDate(flow, context, date, onResult) {
  const url = flow.buildUrl({
    baseUrl: context.baseUrl,
    date,
    serviceAreaId: context.serviceAreaId,
  });

  const isDaFlow = flow.type === "extract-da-itineraries-data";
  const tab = await chrome.tabs.create({
    // Configure rendering before Amazon's first scripts execute in a hidden tab.
    url: isDaFlow ? "about:blank" : url,
    active: isDaFlow ? false : Boolean(context.debugActiveTab),
  });
  const runId = flow.submitPerDriver ? crypto.randomUUID() : null;
  let daKeepAliveId;
  let daRendering;
  let finalResultPromise;
  let resolvePageFinished;
  const pageFinished = new Promise((resolve) => {
    resolvePageFinished = resolve;
  });
  // The page's explicit completion message and executeScript's return can both
  // report this date. Run the notification callback only once.
  function reportResultOnce(result) {
    if (!finalResultPromise) {
      finalResultPromise = Promise.resolve().then(() => onResult?.(result));
      resolvePageFinished([{ result }]);
    }
    return finalResultPromise;
  }

  try {
    if (isDaFlow) {
      daRendering = await enableDaBackgroundRendering(tab.id);
      await chrome.tabs.update(tab.id, { url });
    }
    await waitForTabComplete(tab.id);

    await ensureExpectedTabUrl(flow, context, tab.id, url, date);

    await sleep(flow.postLoadDelayMs ?? 4000);

    await ensureExpectedTabUrl(flow, context, tab.id, url, date);

    if (runId) {
      activeDriverRuns.set(runId, {
        flow,
        context,
        date,
        tabId: tab.id,
        nextSubmissionAt: 0,
        inFlight: false,
        reportResult: reportResultOnce,
      });
    }
    if (flow.type === "extract-da-itineraries-data") {
      // Keep the in-memory run and pending API retries alive until extraction ends.
      // This timer runs in the worker, independently of the Amazon tab's timers.
      daKeepAliveId = setInterval(() => {
        chrome.runtime.getPlatformInfo().catch(() => {
          console.warn("Could not keep the extraction worker active.");
        });
      }, 25000);
    }
    daRendering?.assertConnected();
    const execution = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: flow.extractInPage,
      args: [
        {
          date,
          flowType: context.flowType,
          serviceAreaId: context.serviceAreaId,
          ...(flow.type === "extract-da-itineraries-data" &&
          context.period !== undefined
            ? { period: context.period }
            : {}),
          ...(runId ? { runId } : {}),
        },
      ],
    });

    // An explicit end-of-date handoff is sufficient even if Chrome's original
    // long-running executeScript response is delayed or never arrives.
    const [result] = await (isDaFlow
      ? Promise.race([execution, pageFinished])
      : execution);
    const extractedData = result?.result;

    if (!flow.submitPerDriver) {
      await submitFlowResult(flow, context, { date, extractedData, url });
    }
    // Report the extraction outcome before optional debug waits and tab cleanup.
    if (onResult) await reportResultOnce(extractedData);
  } finally {
    if (daKeepAliveId !== undefined) clearInterval(daKeepAliveId);
    if (runId) activeDriverRuns.delete(runId);
    if (daRendering) await daRendering.release();
    const keepTabOpenMs = Number(context.keepTabOpenMs || 0);

    if (keepTabOpenMs > 0) {
      await sleep(keepTabOpenMs);
    }

    const closeTab = context.closeTab ?? flow.closeTabByDefault ?? true;
    if (closeTab !== false) {
      // A user closing the tab must not replace the original failure/result.
      try { await chrome.tabs.remove(tab.id); } catch { /* Already closed. */ }
    }
  }
}

async function submitFlowResult(flow, context, runResult) {
  if (typeof flow.buildSubmission !== "function") {
    return;
  }

  const submission = flow.buildSubmission({
    context,
    date: runResult.date,
    extractedData: runResult.extractedData,
    url: runResult.url,
  });

  if (Array.isArray(submission)) {
    await submitBatches(flow, context, submission);
    return;
  }

  const response = await sendSubmission(context, submission);
  if (!response.ok) {
    const error = new Error(`Submission failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

async function submitBatches(flow, context, submissions) {
  const delayMs = flow.betweenSubmissionsDelayMs ?? 5000;
  const maxRetries = flow.maxSubmissionRetries ?? 0;
  const statuses = [];

  if (!submissions.length) {
    return statuses;
  }

  for (const [index, submission] of submissions.entries()) {
    if (index > 0) await sleep(delayMs);

    for (let attempt = 0; ; attempt += 1) {
      const response = await sendSubmission(context, submission);
      if (response.ok) {
        statuses.push(response.status);
        break;
      }

      const details = daSubmissionErrors.get(response);
      // The DA receiver sometimes wraps an upstream rate limit in HTTP 500.
      // Retry that explicit error using the same policy as HTTP 429; unrelated
      // server errors and other flows retain their existing behavior.
      const isDaServerRateLimit =
        context.flowType === "extract-da-itineraries-data" &&
        response.status === 500 &&
        /\brate[\s-]+limit\s+exceeded\b/i.test(details || "");
      if (
        (response.status !== 429 && !isDaServerRateLimit) ||
        attempt >= maxRetries
      ) {
        const error = new Error(
          `Batch ${index + 1}/${submissions.length} submission failed: HTTP ${response.status}` +
            (details ? `; API response: ${details}` : ""),
        );
        error.status = response.status;
        throw error;
      }

      const retryAfter = response.headers.get("Retry-After");
      let retryAfterMs = 0;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        retryAfterMs = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();
      }
      const waitMs = Math.max(
        delayMs * 2 ** attempt,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
      );
      console.warn(
        `[${context.flowType}] Batch ${index + 1} rate limited; retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }
  return statuses;
}

async function submitDriverRoute(message, sender) {
  const run = activeDriverRuns.get(message.runId);
  if (!run || sender.tab?.id !== run.tabId) {
    throw new Error(
      "Driver submission does not belong to an active extraction tab",
    );
  }
  if (run.inFlight)
    throw new Error("A driver submission is already in progress");
  run.inFlight = true;
  try {
    const submission = run.flow.buildSubmission({
      context: run.context,
      date: run.date,
      extractedData: {
        route: message.route,
        totalDrivers: message.totalDrivers,
        driverNumber: message.driverNumber,
      },
    });
    const waitMs = run.nextSubmissionAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const [status] = await submitBatches(run.flow, run.context, [submission]);
    return { success: true, status };
  } finally {
    run.nextSubmissionAt =
      Date.now() + (run.flow.betweenSubmissionsDelayMs ?? 5000);
    run.inFlight = false;
  }
}

async function sendSubmission(context, submission) {

  const response = await fetch(submission.url, {
    method: submission.method || "POST",
    headers: submission.headers,
    body: JSON.stringify(submission.body),
    signal: AbortSignal.timeout(60000),
  });

  const responseBody = await response.text();
  if (context.flowType === "extract-da-itineraries-data" && !response.ok) {
    // Relay a bounded diagnostic through the existing error message to the
    // extraction tab. This does not change the request payload or retry policy.
    const limit = 4000;
    const details = responseBody.trim();
    daSubmissionErrors.set(
      response,
      details.length > limit
        ? `${details.slice(0, limit)}… [truncated]`
        : details,
    );
  }
  console.log(`[${context.flowType}] Submission status:`, response.status);
  return response;
}

function buildDaCompletionMessage(context, date, result) {
  const payload = {
    flowType: "extract-da-itineraries-data",
    date,
    period: context.period ?? null,
  };
  const summary = result?.submissionSummary;
  if (summary?.notProcessed > 0) {
    return {
      type: "AMAZON_EXTRACTION_FAILED",
      payload: {
        ...payload,
        error:
          result.submissionResults?.find(
            (item) => item.stage === "not_processed",
          )?.error ||
          "DA extraction stopped before all discovered drivers could be attempted",
      },
    };
  }
  if (
    !Number.isInteger(result?.totalDrivers) ||
    result.totalDrivers < 0 ||
    !Number.isInteger(summary?.successful) ||
    summary.successful < 0 ||
    !Number.isInteger(summary?.failed) ||
    summary.failed < 0 ||
    summary.successful + summary.failed !== result.totalDrivers
  ) {
    return {
      type: "AMAZON_EXTRACTION_FAILED",
      payload: {
        ...payload,
        error: "DA extraction did not return a valid final summary",
      },
    };
  }
  return {
    type: "AMAZON_EXTRACTION_COMPLETE",
    payload: {
      ...payload,
      totalDrivers: result.totalDrivers,
      successfulDrivers: summary.successful,
      failedDrivers: summary.failed,
    },
  };
}

async function notifyDaOrigin(origin, message) {
  if (origin?.tabId == null) return true; // Toolbar runs have no originating webpage.
  const envelope = {
    ...message,
    notificationId: crypto.randomUUID(),
    ...(origin.pageOrigin ? { targetOrigin: origin.pageOrigin } : {}),
  };
  let documentId = origin.documentId;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let timeout;
    try {
      const ack = await Promise.race([
        chrome.tabs.sendMessage(origin.tabId, envelope, {
          frameId: origin.frameId,
          ...(documentId ? { documentId } : {}),
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Completion relay acknowledgment timed out")),
            5000,
          );
        }),
      ]);
      if (ack?.received !== true)
        throw new Error(
          ack?.error || "Content script did not acknowledge the final result",
        );
      console.log(
        `[extract-da-itineraries-data] ${message.type} for ${message.payload.date} relayed to app tab ${origin.tabId}`,
      );
      return true;
    } catch {
      // A same-origin reload replaces the document ID. Only the original top
      // frame may fall back, and content.js checks the origin again at receipt.
      if (documentId && origin.frameId === 0 && origin.pageOrigin) {
        try {
          const tab = await chrome.tabs.get(origin.tabId);
          if (new URL(tab.url).origin === origin.pageOrigin)
            documentId = undefined;
        } catch {
          /* Closed/navigated tabs cannot receive this result. */
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  console.error(
    "[extract-da-itineraries-data] Extraction finished, but its final result could not be relayed to the app:",
  );
  return false;
}

async function runExtraction(payload, origin) {
  const firstDate = payload?.dates?.[0];
  let currentDate = typeof firstDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(firstDate) ? firstDate : null;
  let dateReported = false;
  let claimedKeys = [];
  try {
    const { flow, context } = buildFlowContext(payload);
    const keys = context.dates.map((date) => JSON.stringify([
      context.flowType, context.serviceAreaId, context.period ?? null, date,
    ]));
    // A duplicate start must not report a failure that finalizes the active sync.
    if (keys.some((key) => activeExtractionKeys.has(key))) return;
    if (activeExtractionKeys.size) throw new Error("Another extraction is running. Retry after it finishes.");
    claimedKeys = keys;
    keys.forEach((key) => activeExtractionKeys.add(key));

    for (const date of context.dates) {
      currentDate = date;
      dateReported = false;
      const onResult =
        flow.type === "extract-da-itineraries-data"
          ? async (result) => {
              const message = buildDaCompletionMessage(context, date, result);
              dateReported = true;
              await notifyDaOrigin(origin, message);
            }
          : undefined;
      await executeFlowForDate(flow, context, date, onResult);
      await sleep(flow.betweenDatesDelayMs ?? 1000);
    }
  } catch (error) {
    if (payload?.flowType === "extract-da-itineraries-data" && !dateReported) {
      await notifyDaOrigin(origin, {
        type: "AMAZON_EXTRACTION_FAILED",
        payload: {
          flowType: "extract-da-itineraries-data",
          date: currentDate,
          period: payload.period ?? null,
          error: error?.message || String(error),
        },
      });
    }
    console.error("Extraction failed; check the sync result in the AMP app.");
  } finally {
    claimedKeys.forEach((key) => activeExtractionKeys.delete(key));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "DA_EXTRACTION_FINISHED") {
    const run = activeDriverRuns.get(message.runId);
    if (
      !run ||
      run.flow.type !== "extract-da-itineraries-data" ||
      sender.tab?.id !== run.tabId ||
      run.inFlight
    ) {
      sendResponse({
        received: false,
        error: "Final result does not belong to an idle active DA extraction",
      });
      return;
    }
    run.reportResult(message.result).then(
      () => sendResponse({ received: true }),
      (error) => sendResponse({ received: false, error: error.message }),
    );
    return true;
  }
  if (message.type === "SUBMIT_DA_ROUTE") {
    submitDriverRoute(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        status: error.status ?? null,
        error: error.message,
      }),
    );
    return true;
  }
  if (
    message.type === "START_AMAZON_EXTRACTION" ||
    message.type === "START_FLOW"
  ) {
    let trusted = false;
    try {
      trusted = sender.id === chrome.runtime.id && sender.tab?.id != null &&
        sender.frameId === 0 && sender.origin === TRUSTED_APP_ORIGIN &&
        new URL(sender.url).origin === TRUSTED_APP_ORIGIN;
    } catch { /* Missing/malformed sender metadata is not authorization. */ }
    if (!trusted) {
      sendResponse({ accepted: false, error: "Extraction must be started by the AMP app's top-level page" });
      return;
    }
    const origin = {
      tabId: sender.tab.id,
      frameId: 0,
      documentId: sender.documentId,
      pageOrigin: TRUSTED_APP_ORIGIN,
    };
    runExtraction(message.payload, origin);
    sendResponse({ accepted: true });
  }
});
