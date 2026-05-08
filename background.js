console.log("BACKGROUND>JS started");

import { FLOW_REGISTRY } from "./flows/index.js";

const DEFAULT_FLOW_TYPE = "extract-route-assignments-data";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
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

async function executeFlowForDate(flow, context, date) {
  const url = flow.buildUrl({
    baseUrl: context.baseUrl,
    date,
    serviceAreaId: context.serviceAreaId,
  });

  console.log(`[${context.flowType}] Processing date: ${date}`);
  console.log(`[${context.flowType}] Requested URL: ${url}`);

  const tab = await chrome.tabs.create({
    url,
    active: Boolean(context.debugActiveTab),
  });

  console.log(
    `[${context.flowType}] Created tab ${tab.id} with initial URL:`,
    tab.url,
  );

  try {
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

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: flow.extractInPage,
      args: [
        {
          date,
          flowType: context.flowType,
          serviceAreaId: context.serviceAreaId,
          token: context.token,
        },
      ],
    });

    const extractedData = result?.result;
    console.log(`[${context.flowType}] executeScript result wrapper:`, result);
    console.log(`[${context.flowType}] Extracted data:`, extractedData);

    await submitFlowResult(flow, context, {
      date,
      extractedData,
      url,
    });
  } finally {
    const keepTabOpenMs = Number(context.keepTabOpenMs || 0);

    if (keepTabOpenMs > 0) {
      console.log(
        `[${context.flowType}] Keeping tab ${tab.id} open for ${keepTabOpenMs}ms for debugging`,
      );
      await sleep(keepTabOpenMs);
    }

    if (context.closeTab === false) {
      console.log(
        `[${context.flowType}] Leaving tab ${tab.id} open for debugging`,
      );
      return;
    }

    await chrome.tabs.remove(tab.id);
  }
}

async function submitFlowResult(flow, context, runResult) {
  const submission = flow.buildSubmission({
    context,
    date: runResult.date,
    extractedData: runResult.extractedData,
    url: runResult.url,
  });

  console.log(`[${context.flowType}] Submitting payload:`, submission.body);

  const response = await fetch(submission.url, {
    method: submission.method || "POST",
    headers: submission.headers,
    body: JSON.stringify(submission.body),
  });

  const responseBody = await response.text();
  console.log(`[${context.flowType}] Submission status:`, response.status);
  console.log(`[${context.flowType}] Submission body:`, responseBody);
}

async function runExtraction(payload) {
  try {
    const { flow, context } = buildFlowContext(payload);
    console.log(
      `[${context.flowType}] Starting batch extraction:`,
      context.dates,
    );

    for (const date of context.dates) {
      await executeFlowForDate(flow, context, date);
      await sleep(flow.betweenDatesDelayMs ?? 1000);
    }

    console.log(`[${context.flowType}] Batch extraction completed`);
  } catch (error) {
    console.error("runExtraction failed:", error);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    message.type === "START_AMAZON_EXTRACTION" ||
    message.type === "START_FLOW"
  ) {
    runExtraction(message.payload);
  }
});

chrome.action.onClicked.addListener(() => {
  runExtraction({
    //flowType: "extract-work-summary-tool-data",
    //flowType: "extract-route-assignments-data",
    flowType: "extract-weekly-schedule",
    serviceAreaId: "221c60b4-2825-4fdf-80de-360cdc73e8f4",
    baseUrl:
      //"https://logistics.amazon.com/harmony/v2/#!/dsp-portal?serviceAreaId={serviceAreaId}&localDate={date}",
      //"https://logistics.amazon.com/scheduling?serviceAreaId={serviceAreaId}&date={date}",
      "https://logistics.amazon.com/scheduling/calendar-view/week?date={date}&serviceAreaId={serviceAreaId}",
    dates: ["2026-04-16"],
    token: "test-token",
    debugActiveTab: true,
    keepTabOpenMs: 60000,
  });
});
