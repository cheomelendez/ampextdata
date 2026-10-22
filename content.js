console.log("✅ content.js injected");
console.log("chrome.runtime:", chrome.runtime);
const deliveredDaNotifications = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.payload?.flowType === "extract-da-itineraries-data" &&
    (message.type === "AMAZON_EXTRACTION_COMPLETE" ||
      message.type === "AMAZON_EXTRACTION_FAILED")
  ) {
    if (message.targetOrigin && message.targetOrigin !== window.location.origin) {
      sendResponse({ received: false, error: "Originating app is no longer loaded in this frame" });
      return;
    }
    if (message.notificationId && deliveredDaNotifications.has(message.notificationId)) {
      sendResponse({ received: true });
      return;
    }
    window.postMessage(
      { type: message.type, payload: message.payload },
      window.location.origin,
    );
    console.log(`[AMP Extractor] ${message.type} for ${message.payload.date} posted to webpage`);
    if (message.notificationId) {
      deliveredDaNotifications.add(message.notificationId);
      if (deliveredDaNotifications.size > 100) {
        deliveredDaNotifications.delete(deliveredDaNotifications.values().next().value);
      }
    }
    sendResponse({ received: true });
  }
});

window.addEventListener("message", (event) => {
  if (event.data?.type === "START_AMAZON_EXTRACTION") {
    try {
      chrome.runtime.sendMessage(
        {
          type: "START_AMAZON_EXTRACTION",
          payload: event.data.payload,
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error(
              "Failed to relay START_AMAZON_EXTRACTION to extension:",
              chrome.runtime.lastError.message,
            );
          }
        },
      );
    } catch (error) {
      console.error(
        "Extension context invalidated while relaying START_AMAZON_EXTRACTION. Reload the page after reloading the extension.",
        error,
      );
    }
  }
});
