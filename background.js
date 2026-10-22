console.log("BACKGROUND>JS started");

import { FLOW_REGISTRY } from "./flows/index.js";

const DEFAULT_FLOW_TYPE = "extract-route-assignments-data";
const activeDriverRuns = new Map();
// Keep the DA API's rejection reason after the response body has been read.
const daSubmissionErrors = new WeakMap();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // The tab may have finished loading before the listener was attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch((error) => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(error);
      });
  });
}

async function ensureExpectedTabUrl(flow, context, tabId, expectedUrl, date) {
  if (typeof flow.matchesExpectedUrl !== "function") {
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = currentTab.url || "";

    console.log(
      `[${context.flowType}] URL validation attempt ${attempt}:`,
      currentUrl,
    );

    if (flow.matchesExpectedUrl({ currentUrl, expectedUrl, date })) {
      return;
    }

    console.warn(
      `[${context.flowType}] Unexpected URL detected. Re-navigating to expected URL for date ${date}`,
    );

    await chrome.tabs.update(tabId, { url: expectedUrl });
    await waitForTabComplete(tabId);
    await sleep(2000);
  }
}

function buildFlowContext(payload) {
  const flowType = payload.flowType || DEFAULT_FLOW_TYPE;
  const flow = FLOW_REGISTRY[flowType];

  if (!flow) {
    throw new Error(`Unsupported flow type: ${flowType}`);
  }

  const context = {
    ...payload,
    flowType,
  };

  if (!context.baseUrl) {
    context.baseUrl = flow.defaultBaseUrl;
  }

  if (
    !context.baseUrl ||
    !context.dates?.length ||
    !context.serviceAreaId ||
    !context.token
  ) {
    throw new Error("Missing required payload fields");
  }

  return { flow, context };
}

async function enableDaBackgroundRendering(tabId) {
  if (!chrome.debugger) {
    throw new Error("DA background rendering requires the debugger permission. Reload the updated extension.");
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
    console.error("[extract-da-itineraries-data]", interrupted.message);
  }
  async function release() {
    if (released) return;
    released = true;
    chrome.debugger.onDetach.removeListener(onDetach);
    if (!attached) return;
    try {
      await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: false });
    } catch (error) {
      console.warn("[extract-da-itineraries-data] Could not clear focus emulation:", error.message);
    } finally {
      try {
        await chrome.debugger.detach(target);
      } catch (error) {
        console.warn("[extract-da-itineraries-data] Could not detach rendering session:", error.message);
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
    await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
    if (interrupted) throw interrupted;
    console.log("[extract-da-itineraries-data] Background rendering enabled; your app tab stays active");
    return {
      release,
      assertConnected() { if (interrupted) throw interrupted; },
    };
  } catch (error) {
    await release();
    throw new Error(`Could not enable DA background rendering: ${error.message}`);
  }
}

async function executeFlowForDate(flow, context, date, onResult) {
  const url = flow.buildUrl({
    baseUrl: context.baseUrl,
    date,
    serviceAreaId: context.serviceAreaId,
  });

  console.log(`[${context.flowType}] Processing date: ${date}`);
  console.log(`[${context.flowType}] Requested URL: ${url}`);

  const isDaFlow = flow.type === "extract-da-itineraries-data";
  const tab = await chrome.tabs.create({
    // Configure rendering before Amazon's first scripts execute in a hidden tab.
    url: isDaFlow ? "about:blank" : url,
    active: isDaFlow
      ? false
      : Boolean(context.debugActiveTab),
  });
  const runId = flow.submitPerDriver ? crypto.randomUUID() : null;
  let daKeepAliveId;
  let daRendering;
  let finalResultPromise;
  let resolvePageFinished;
  const pageFinished = new Promise((resolve) => { resolvePageFinished = resolve; });
  // The page's explicit completion message and executeScript's return can both
  // report this date. Run the notification callback only once.
  function reportResultOnce(result) {
    if (!finalResultPromise) {
      finalResultPromise = Promise.resolve().then(() => onResult?.(result));
      resolvePageFinished([{ result }]);
    }
    return finalResultPromise;
  }

  console.log(
    `[${context.flowType}] Created tab ${tab.id} with initial URL:`,
    tab.url,
  );

  try {
    if (isDaFlow) {
      daRendering = await enableDaBackgroundRendering(tab.id);
      await chrome.tabs.update(tab.id, { url });
    }
    await waitForTabComplete(tab.id);
    console.log(`[${context.flowType}] Tab loaded`);

    const loadedTab = await chrome.tabs.get(tab.id);
    console.log(`[${context.flowType}] Tab URL after load:`, loadedTab.url);

    await ensureExpectedTabUrl(flow, context, tab.id, url, date);

    await sleep(flow.postLoadDelayMs ?? 4000);

    const delayedTab = await chrome.tabs.get(tab.id);
    console.log(
      `[${context.flowType}] Tab URL before executeScript after delay:`,
      delayedTab.url,
    );

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
        chrome.runtime.getPlatformInfo().catch((error) => {
          console.warn("Could not keep the active DA extraction worker alive:", error);
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
          token: context.token,
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
    const [result] = await (isDaFlow ? Promise.race([execution, pageFinished]) : execution);
    const extractedData = result?.result;
    console.log(`[${context.flowType}] executeScript result wrapper:`, result);
    console.log(`[${context.flowType}] Extracted data:`, extractedData);

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
      console.log(
        `[${context.flowType}] Keeping tab ${tab.id} open for ${keepTabOpenMs}ms for debugging`,
      );
      await sleep(keepTabOpenMs);
    }

    const closeTab = context.closeTab ?? flow.closeTabByDefault ?? true;
    if (closeTab === false) {
      console.log(
        `[${context.flowType}] Leaving tab ${tab.id} open for debugging`,
      );
    } else {
      await chrome.tabs.remove(tab.id);
    }
  }
}

async function submitFlowResult(flow, context, runResult) {
  if (typeof flow.buildSubmission !== "function") {
    console.log(
      `[${context.flowType}] Console-only flow completed; no submission configured`,
    );
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

  await sendSubmission(context, submission);
}

async function submitBatches(flow, context, submissions) {
  const delayMs = flow.betweenSubmissionsDelayMs ?? 5000;
  const maxRetries = flow.maxSubmissionRetries ?? 0;
  const statuses = [];

  if (!submissions.length) {
    console.log(`[${context.flowType}] No driver batches to submit`);
    return statuses;
  }

  for (const [index, submission] of submissions.entries()) {
    if (index > 0) await sleep(delayMs);
    console.log(
      `[${context.flowType}] Submitting batch ${index + 1}/${submissions.length}`,
    );

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
      if ((response.status !== 429 && !isDaServerRateLimit) || attempt >= maxRetries) {
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
  console.log(`[${context.flowType}] Submitting payload:`, submission.body);

  const response = await fetch(submission.url, {
    method: submission.method || "POST",
    headers: submission.headers,
    body: JSON.stringify(submission.body),
  });

  const responseBody = await response.text();
  if (context.flowType === "extract-da-itineraries-data" && !response.ok) {
    // Relay a bounded diagnostic through the existing error message to the
    // extraction tab. This does not change the request payload or retry policy.
    const limit = 4000;
    const details = responseBody.trim();
    daSubmissionErrors.set(
      response,
      details.length > limit ? `${details.slice(0, limit)}… [truncated]` : details,
    );
  }
  console.log(`[${context.flowType}] Submission status:`, response.status);
  console.log(`[${context.flowType}] Submission body:`, responseBody);
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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let timeout;
    try {
      const ack = await Promise.race([
        chrome.tabs.sendMessage(origin.tabId, envelope, {
          frameId: origin.frameId,
          ...(documentId ? { documentId } : {}),
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Completion relay acknowledgment timed out")), 5000);
        }),
      ]);
      if (ack?.received !== true) throw new Error(ack?.error || "Content script did not acknowledge the final result");
      console.log(`[extract-da-itineraries-data] ${message.type} for ${message.payload.date} relayed to app tab ${origin.tabId}`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`[extract-da-itineraries-data] Final-result delivery attempt ${attempt}/3 failed:`, error.message);
      // A same-origin reload replaces the document ID. Only the original top
      // frame may fall back, and content.js checks the origin again at receipt.
      if (documentId && origin.frameId === 0 && origin.pageOrigin) {
        try {
          const tab = await chrome.tabs.get(origin.tabId);
          if (new URL(tab.url).origin === origin.pageOrigin) documentId = undefined;
        } catch { /* Closed/navigated tabs cannot receive this result. */ }
      }
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  console.error("[extract-da-itineraries-data] Extraction finished, but its final result could not be relayed to the app:", message, lastError);
  return false;
}

async function runExtraction(payload, origin) {
  let currentDate = payload?.dates?.[0] ?? null;
  let dateReported = false;
  try {
    const { flow, context } = buildFlowContext(payload);
    console.log(
      `[${context.flowType}] Starting batch extraction:`,
      context.dates,
    );

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

    console.log(`[${context.flowType}] Batch extraction completed`);
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
    console.error("runExtraction failed:", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "DA_EXTRACTION_FINISHED") {
    const run = activeDriverRuns.get(message.runId);
    if (!run || run.flow.type !== "extract-da-itineraries-data" ||
        sender.tab?.id !== run.tabId || run.inFlight) {
      sendResponse({ received: false, error: "Final result does not belong to an idle active DA extraction" });
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
    const origin = sender.tab
      ? {
          tabId: sender.tab.id,
          frameId: sender.frameId ?? 0,
          documentId: sender.documentId,
          pageOrigin: sender.origin || (sender.url ? new URL(sender.url).origin : undefined),
        }
      : undefined;
    runExtraction(message.payload, origin);
  }
});

chrome.action.onClicked.addListener(() => {
  runExtraction({
    flowType: "extract-da-itineraries-data",
    //flowType: "extract-work-summary-tool-data",
    //flowType: "extract-route-assignments-data",
    //flowType: "extract-weekly-schedule",
    serviceAreaId: "221c60b4-2825-4fdf-80de-360cdc73e8f4",
    baseUrl:
      "https://logistics.amazon.com/operations/execution/dv/routes?navMenuVariant=external&provider=ALL_DRIVERS&selectedDay={date}&serviceAreaId={serviceAreaId}",
    //"https://logistics.amazon.com/harmony/v2/#!/dsp-portal?serviceAreaId={serviceAreaId}&localDate={date}",
    //"https://logistics.amazon.com/scheduling?serviceAreaId={serviceAreaId}&date={date}",
    //"https://logistics.amazon.com/scheduling/calendar-view/week?date={date}&serviceAreaId={serviceAreaId}",
    dates: ["2026-09-13"],
    period: "6a36db1aa9724742475c5457", // DA itineraries only; ignored by the other flows.
    token: "test-token",
    debugActiveTab: true,
    closeTab: false,
  });
});
