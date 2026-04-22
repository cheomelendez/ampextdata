console.log("✅ content.js injected");
console.log("chrome.runtime:", chrome.runtime);
window.addEventListener("message", (event) => {
    if (event.data?.type === "START_AMAZON_EXTRACTION") {
        chrome.runtime.sendMessage({
            type: "START_FLOW",
            payload: event.data.payload
        });
    }
});
