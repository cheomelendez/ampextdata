// ===== helpers =====
function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function waitForTabComplete(tabId) {
    return new Promise(resolve => {
        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

// ===== main flow =====
async function runExtraction(payload) {
    try {
        const { baseUrl, dates, token, serviceAreaId } = payload;

        if (!baseUrl || !dates?.length || !serviceAreaId || !token) {
            console.error("❌ Missing required payload fields");
            return;
        }

        console.log("🟡 Starting batch extraction:", dates);

        for (const date of dates) {

            let url = baseUrl
                .replace("{date}", date)
                .replace("{serviceAreaId}", serviceAreaId);

            console.log(`📅 Processing date: ${date}`);
            console.log(`🔗 URL: ${url}`);

            const tab = await chrome.tabs.create({
                url,
                active: false
            });

            await waitForTabComplete(tab.id);
            console.log("🟢 Tab loaded");

            await sleep(4000);

            console.log("🚀 Running extraction (with context)");

            // ✅ SINGLE EXECUTION WITH CONTEXT
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: async (context) => {

                    console.log("📦 Context received:", context);

                    // function parseRow(row) {
                    //     const headerText =
                    //         row.querySelector(".rowHeader span")?.innerText?.trim() || "";

                    //     const fullRowText = row.innerText || "";

                    //     const dataFields = row.querySelectorAll(".rowHeaderData");

                    //     let confirmed = Number(
                    //         dataFields[0]?.querySelector("span")?.innerText || 0
                    //     );

                    //     let rostered = Number(
                    //         dataFields[1]?.querySelector("span")?.innerText || 0
                    //     );

                    //     // 🔥 EDGE CASE (robust detection)
                    //     const isMiscRow = /miscellaneous route assignments/i.test(fullRowText);
                    //     const hasStation = /station/i.test(fullRowText);
                    //     const hasDuration = /\d+\s*hours?/i.test(fullRowText);

                    //     if (isMiscRow && !hasStation && !hasDuration) {
                    //         const submitMatch = fullRowText.match(/(\d+)\s*submit/i);
                    //         const submit = submitMatch ? Number(submitMatch[1]) : 0;

                    //         return {
                    //             service: "Miscellaneous Route Assignments",
                    //             type: null,
                    //             station: null,
                    //             duration: null,
                    //             submit,
                    //             confirmed: 0,
                    //             rostered: 0
                    //         };
                    //     }

                    //     // 🔹 Duration
                    //     const durationMatch = headerText.match(/(\d+\s*Hours?)/i);
                    //     const duration = durationMatch ? durationMatch[1] : null;

                    //     // 🔹 Station
                    //     let station = null;
                    //     const stationMatch = headerText.match(/-\s*([^-\n]*station[^-\n]*)/i);
                    //     if (stationMatch) {
                    //         station = stationMatch[1].trim();
                    //     }

                    //     // 🔹 Clean text
                    //     let cleaned = headerText;

                    //     if (duration) cleaned = cleaned.replace(duration, "");
                    //     if (station) cleaned = cleaned.replace(`- ${station}`, "");

                    //     cleaned = cleaned.replace(/\d+\s*Confirmed/i, "");
                    //     cleaned = cleaned.replace(/\d+\s*Rostered/i, "");

                    //     cleaned = cleaned
                    //         .replace(/\s*-\s*/g, " - ")
                    //         .replace(/-\s*$/, "")
                    //         .replace(/^\s*-\s*/, "")
                    //         .trim();

                    //     const parts = cleaned
                    //         .split(" - ")
                    //         .map(p => p.trim().replace(/-$/, "").trim())
                    //         .filter(Boolean);

                    //     function isVehicleSegment(segment) {
                    //         return /(Van|Step Van|Vehicle)/i.test(segment);
                    //     }

                    //     let serviceParts = [];
                    //     let remainingParts = [];

                    //     parts.forEach((segment, index) => {
                    //         if (index === 0 || isVehicleSegment(segment)) {
                    //             serviceParts.push(segment);
                    //         } else {
                    //             remainingParts.push(segment);
                    //         }
                    //     });

                    //     const service = serviceParts.length
                    //         ? serviceParts.join(" - ")
                    //         : null;

                    //     const type = remainingParts.length
                    //         ? remainingParts.join(" - ")
                    //         : null;

                    //     return {
                    //         service,
                    //         type,
                    //         station,
                    //         duration,
                    //         confirmed,
                    //         rostered
                    //     };
                    // }

                    function parseRow(row) {

                        // 🔥 FIX #1: explicitly find the correct ancestor ".row"
                        const rowContainer = row.closest(".row");

                        // 🔥 FIX #2: skip ONLY if THAT row is hidden
                        if (
                            !rowContainer ||
                            rowContainer.style.display === "none" ||
                            getComputedStyle(rowContainer).display === "none"
                        ) {
                            return null;
                        }

                        const headerEl = row.querySelector(".rowHeader");

                        const headerText =
                            headerEl?.querySelector("span")?.innerText?.trim() || "";

                        const fullRowText = row.innerText || "";

                        const dataFields = row.querySelectorAll(".rowHeaderData");

                        let confirmed = Number(
                            dataFields[0]?.querySelector("span")?.innerText || 0
                        );

                        let rostered = Number(
                            dataFields[1]?.querySelector("span")?.innerText || 0
                        );

                        // 🔥 EDGE CASE (Misc)
                        const isMiscRow = /miscellaneous route assignments/i.test(fullRowText);
                        const hasStation = /station/i.test(fullRowText);
                        const hasDuration = /\d+\s*hours?/i.test(fullRowText);

                        if (isMiscRow && !hasStation && !hasDuration) {
                            const submitMatch = fullRowText.match(/(\d+)\s*submit/i);
                            const submit = submitMatch ? Number(submitMatch[1]) : 0;

                            return {
                                service: "Miscellaneous Route Assignments",
                                type: null,
                                station: null,
                                duration: null,
                                submit,
                                confirmed: 0,
                                rostered: 0
                            };
                        }

                        // 🔹 Duration
                        const durationMatch = headerText.match(/(\d+\s*Hours?)/i);
                        const duration = durationMatch ? durationMatch[1] : null;

                        // 🔹 Station
                        let station = null;
                        const stationMatch = headerText.match(/-\s*([^-\n]*station[^-\n]*)/i);
                        if (stationMatch) {
                            station = stationMatch[1].trim();
                        }

                        // 🔹 Clean text
                        let cleaned = headerText;

                        if (duration) cleaned = cleaned.replace(duration, "");
                        if (station) cleaned = cleaned.replace(`- ${station}`, "");

                        cleaned = cleaned.replace(/\d+\s*Confirmed/i, "");
                        cleaned = cleaned.replace(/\d+\s*Rostered/i, "");

                        cleaned = cleaned
                            .replace(/\s*-\s*/g, " - ")
                            .replace(/-\s*$/, "")
                            .replace(/^\s*-\s*/, "")
                            .trim();

                        const parts = cleaned
                            .split(" - ")
                            .map(p => p.trim().replace(/-$/, "").trim())
                            .filter(Boolean);

                        function isVehicleSegment(segment) {
                            return /(Van|Step Van|Vehicle)/i.test(segment);
                        }

                        let serviceParts = [];
                        let remainingParts = [];

                        parts.forEach((segment, index) => {
                            if (index === 0 || isVehicleSegment(segment)) {
                                serviceParts.push(segment);
                            } else {
                                remainingParts.push(segment);
                            }
                        });

                        const service = serviceParts.length
                            ? serviceParts.join(" - ")
                            : null;

                        const type = remainingParts.length
                            ? remainingParts.join(" - ")
                            : null;

                        return {
                            service,
                            type,
                            station,
                            duration,
                            confirmed,
                            rostered
                        };
                    }

                    function extract() {
                        const container = document.querySelector("#confirmedServiceRequestSection");
                        if (!container) {
                            console.warn("❌ Container not found");
                            return [];
                        }

                        const rows = container.querySelectorAll(".rowHeaderContainer");
                        console.log("✅ Rows detected:", rows.length);

                        //return Array.from(rows).map(parseRow);
                        // 🔥 FIX: map + filter(Boolean)
                        const results = Array.from(rows)
                            .map(parseRow)
                            .filter(Boolean);

                        console.log("🚀 Extracted Data:", results);
                        console.log("📊 Total valid rows:", results.length);
                        return results;
                    }

                    function waitForUI() {
                        return new Promise(resolve => {
                            if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
                                return resolve();
                            }

                            const obs = new MutationObserver(() => {
                                if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
                                    obs.disconnect();
                                    resolve();
                                }
                            });

                            obs.observe(document.body, { childList: true, subtree: true });

                            setTimeout(() => {
                                obs.disconnect();
                                resolve();
                            }, 10000);
                        });
                    }

                    await waitForUI();

                    const data = extract();

                    console.log("🚀 Extracted Data:", data);
                    console.log("🔐 Token:", context.token);
                    console.log("📅 Date:", context.date);
                    console.log("🧭 ServiceAreaId:", context.serviceAreaId);

                    try {
                        const response = await fetch("https://recon.amngtpro.com/api/functions/receiveRouteData", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${context.token}`
                            },
                            body: JSON.stringify({
                                date: context.date,
                                serviceAreaId: context.serviceAreaId,
                                services: data
                            })
                        });

                        console.log("📡 Status:", response.status);
                        console.log("📡 Body:", await response.text());

                    } catch (err) {
                        console.error("❌ Fetch error:", err);
                    }
                },
                args: [{ token, date, serviceAreaId }]
            });

            await sleep(5000);

            await chrome.tabs.remove(tab.id);
        }

        console.log("✅ Batch extraction completed");

    } catch (err) {
        console.error("❌ runExtraction failed:", err);
    }
}

// ===== listeners =====
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "START_FLOW") {
        runExtraction(msg.payload);
    }
});

// optional manual test
chrome.action.onClicked.addListener(() => {
    runExtraction({
        serviceAreaId: "221c60b4-2825-4fdf-80de-360cdc73e8f4",
        baseUrl: "https://logistics.amazon.com/scheduling?serviceAreaId={serviceAreaId}&date={date}",
        dates: ["2026-03-08"],
        token: "test-token"
    });
});

// // ===== helpers =====
// function sleep(ms) {
//     return new Promise(res => setTimeout(res, ms));
// }

// function waitForTabComplete(tabId) {
//     return new Promise(resolve => {
//         function listener(updatedTabId, info) {
//             if (updatedTabId === tabId && info.status === "complete") {
//                 chrome.tabs.onUpdated.removeListener(listener);
//                 resolve();
//             }
//         }
//         chrome.tabs.onUpdated.addListener(listener);
//     });
// }

// // ===== main flow =====
// async function runExtraction(payload) {
//     try {
//         const { baseUrl, dates, token, serviceAreaId } = payload;

//         if (!baseUrl || !dates?.length || !serviceAreaId) {
//             console.error("❌ Missing required payload fields");
//             return;
//         }

//         console.log("🟡 Starting batch extraction:", dates);

//         for (const date of dates) {

//             // 🔥 Replace BOTH placeholders
//             let url = baseUrl
//                 .replace("{date}", date)
//                 .replace("{serviceAreaId}", serviceAreaId);

//             console.log(`📅 Processing date: ${date}`);
//             console.log(`🔗 URL: ${url}`);

//             const tab = await chrome.tabs.create({
//                 url,
//                 active: false
//             });

//             await waitForTabComplete(tab.id);
//             console.log("🟢 Tab loaded");

//             await sleep(4000);

//             console.log("🚀 Injecting extractor.js");

//             await chrome.scripting.executeScript({
//                 target: { tabId: tab.id },
//                 files: ["extractor.js"]
//             });

//             // pass context
//             await chrome.tabs.sendMessage(tab.id, {
//                 type: "SET_CONTEXT",
//                 payload: { token, date, serviceAreaId }
//             });

//             // wait extraction
//             await sleep(7000);

//             await chrome.tabs.remove(tab.id);
//         }

//         console.log("✅ Batch extraction completed");

//     } catch (err) {
//         console.error("❌ runExtraction failed:", err);
//     }
// }

// // ===== listeners =====
// chrome.runtime.onMessage.addListener((msg) => {
//     if (msg.type === "START_FLOW") {
//         runExtraction(msg.payload);
//     }
// });

// // optional manual test
// chrome.action.onClicked.addListener(() => {
//     runExtraction({
//         serviceAreaId: "221c60b4-2825-4fdf-80de-360cdc73e8f4",
//         baseUrl: "https://logistics.amazon.com/scheduling?serviceAreaId=221c60b4-2825-4fdf-80de-360cdc73e8f4&date=2026-04-02",
//         dates: ["2026-04-02"],
//         token: "eyJhbGciOiJIUzI1NiJ9.eyJ3ZWVrSWQiOiI2OWQ5MWFiZGY1OTQ0ZDQ2ZmUzOTAyZDMiLCJzdGF0aW9uSWQiOiI2OWQ3ZThhYWI1ZTEzZGViM2Y4MTk4ZGIiLCJpYXQiOjE3NzYxMDY0MDYsImV4cCI6MTc3NjEwNjUyNn0.MWW__s99eeKtCUxoxZXg9ROamwnjf3lCMoDPeGR0tBs"
//     });
// });




// // ===== helpers =====
// // function sleep(ms) {
// //     return new Promise(res => setTimeout(res, ms));
// // }

// // function waitForTabComplete(tabId) {
// //     return new Promise(resolve => {
// //         function listener(updatedTabId, info) {
// //             if (updatedTabId === tabId && info.status === "complete") {
// //                 chrome.tabs.onUpdated.removeListener(listener);
// //                 resolve();
// //             }
// //         }
// //         chrome.tabs.onUpdated.addListener(listener);
// //     });
// // }

// // // ===== receive extracted data =====
// // chrome.runtime.onMessage.addListener((msg) => {
// //     if (msg.type === "EXTRACTED_DATA") {
// //         console.log("📦 Data from page:", msg.payload);
// //     }
// // });

// // // ===== main flow =====
// // async function runExtraction(url) {
// //     try {
// //         const tab = await chrome.tabs.create({
// //             url,
// //             active: false
// //         });

// //         console.log("🟡 Amazon tab opened:", tab.id);

// //         await waitForTabComplete(tab.id);
// //         console.log("🟢 Tab loaded");

// //         await sleep(4000); // allow SPA render

// //         console.log("🚀 Injecting extractor.js");

// //         await chrome.scripting.executeScript({
// //             target: { tabId: tab.id },
// //             files: ["extractor.js"]
// //         });

// //     } catch (err) {
// //         console.error("❌ runExtraction failed:", err);
// //     }
// // }

// // // ===== extension click =====
// // chrome.action.onClicked.addListener(() => {
// //     console.log("🖱️ Extension clicked");

// //     const url =
// //         "https://logistics.amazon.com/scheduling?serviceAreaId=221c60b4-2825-4fdf-80de-360cdc73e8f4&date=2026-03-22";

// //     runExtraction(url);
// // });

// // // ===== trigger from Base44 =====
// // chrome.runtime.onMessage.addListener((msg) => {
// //     if (msg.type === "START_FLOW") {
// //         runExtraction(msg.payload.url);
// //     }
// // });
