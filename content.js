console.log("✅ content.js injected");
console.log("chrome.runtime:", chrome.runtime);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.payload?.flowType === "extract-da-itineraries-data" &&
    (message.type === "AMAZON_EXTRACTION_COMPLETE" ||
      message.type === "AMAZON_EXTRACTION_FAILED")
  ) {
    window.postMessage(
      { type: message.type, payload: message.payload },
      window.location.origin,
    );
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
