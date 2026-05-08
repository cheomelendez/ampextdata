console.log("✅ content.js injected");
console.log("chrome.runtime:", chrome.runtime);

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
