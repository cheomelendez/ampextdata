// console.log("🚀 extractor.js loaded");

// let CONTEXT = {
//     token: null,
//     date: null
// };

// // 🔹 receive context from background
// chrome.runtime.onMessage.addListener((msg) => {
//     if (msg.type === "SET_CONTEXT") {
//         CONTEXT = msg.payload;
//         console.log("📦 Context received:", CONTEXT);
//     }
// });

// function parseRow(row) {
//     const headerText =
//         row.querySelector(".rowHeader span")?.innerText?.trim() || "";

//     const dataFields = row.querySelectorAll(".rowHeaderData");

//     const confirmed = Number(
//         dataFields[0]?.querySelector("span")?.innerText || 0
//     );

//     const rostered = Number(
//         dataFields[1]?.querySelector("span")?.innerText || 0
//     );

//     const durationMatch = headerText.match(/(\d+\sHours?)/i);
//     const duration = durationMatch ? durationMatch[1] : null;

//     const clean = headerText.replace(/\d+\sHours?/i, "").trim();
//     const parts = clean.split(" - ").map(p => p.trim());

//     return {
//         service: parts.slice(0, 2).join(" - ") || parts[0],
//         type: parts[1] || null,
//         station: parts[2] || null,
//         duration,
//         confirmed,
//         rostered
//     };
// }

// function extract() {
//     const container = document.querySelector("#confirmedServiceRequestSection");

//     if (!container) {
//         console.warn("❌ container not found");
//         return [];
//     }

//     const rows = container.querySelectorAll(".rowHeaderContainer");

//     return Array.from(rows).map(parseRow);
// }

// function waitForUI() {
//     return new Promise(resolve => {
//         if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
//             return resolve();
//         }

//         const obs = new MutationObserver(() => {
//             if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
//                 obs.disconnect();
//                 resolve();
//             }
//         });

//         obs.observe(document.body, { childList: true, subtree: true });

//         setTimeout(() => {
//             obs.disconnect();
//             resolve();
//         }, 10000);
//     });
// }

// (async () => {
//     await waitForUI();

//     const data = extract();

//     console.log("🚀 Extracted Data:", data);

//     try {
//         await fetch("https://recon.amngtpro.com/api/functions/receiveRouteData", {
//             method: "POST",
//             headers: {
//                 "Content-Type": "application/json",
//                 Authorization: `Bearer ${CONTEXT.token}`
//             },
//             body: JSON.stringify({
//                 date: CONTEXT.date,
//                 serviceAreaId: CONTEXT.serviceAreaId,
//                 services: data
//             })
//         });

//         const responseText = await response.text();
//         console.log("📡 Response body:", responseText);

//         if (!response.ok) {
//             console.error("❌ API ERROR:", response.status, responseText);
//         } else {
//             console.log("✅ Data sent successfully");
//         }
//     } catch (err) {
//         console.warn("❌  API failed:", err.message);
//     }
// })();


// // console.log("🚀 extractor.js loaded");

// // function parseRow(row) {
// //     const headerText =
// //         row.querySelector(".rowHeader span")?.innerText?.trim() || "";

// //     const dataFields = row.querySelectorAll(".rowHeaderData");

// //     const confirmed = Number(
// //         dataFields[0]?.querySelector("span")?.innerText || 0
// //     );

// //     const rostered = Number(
// //         dataFields[1]?.querySelector("span")?.innerText || 0
// //     );

// //     const durationMatch = headerText.match(/(\d+\sHours?)/i);
// //     const duration = durationMatch ? durationMatch[1] : null;

// //     const clean = headerText.replace(/\d+\sHours?/i, "").trim();
// //     const parts = clean.split(" - ").map(p => p.trim());

// //     return {
// //         service: parts.slice(0, 2).join(" - ") || parts[0],
// //         type: parts[1] || null,
// //         station: parts[2] || null,
// //         duration,
// //         confirmed,
// //         rostered
// //     };
// // }

// // function extract() {
// //     const container = document.querySelector("#confirmedServiceRequestSection");

// //     if (!container) {
// //         console.warn("❌ container not found");
// //         return [];
// //     }

// //     const rows = container.querySelectorAll(".rowHeaderContainer");

// //     console.log("✅ Rows detected:", rows.length);

// //     return Array.from(rows).map(parseRow);
// // }

// // function waitForUI() {
// //     return new Promise(resolve => {
// //         if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
// //             return resolve();
// //         }

// //         const obs = new MutationObserver(() => {
// //             if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
// //                 obs.disconnect();
// //                 resolve();
// //             }
// //         });

// //         obs.observe(document.body, { childList: true, subtree: true });

// //         setTimeout(() => {
// //             obs.disconnect();
// //             resolve();
// //         }, 10000);
// //     });
// // }

// // (async () => {
// //     await waitForUI();

// //     const data = extract();

// //     console.log("🚀 Extracted Data:", data);

// //     // send to background
// //     chrome.runtime.sendMessage({
// //         type: "EXTRACTED_DATA",
// //         payload: data
// //     });

// //     // send to API
// //     try {
// //         await fetch("https://recon.amngtpro.com/api/functions/receiveRouteData", {
// //             method: "POST",
// //             headers: {
// //                 "Content-Type": "application/json",
// //                 "Authorization":"Bearer f9169fac6c0e04f2cbda090acf2dd1606d70a6ebfca31586c18229057436c61e"
// //             },
// //             body: JSON.stringify({
// //                 date: new URL(location.href).searchParams.get('date'),
// //                 serviceAreaId: new URL(location.href).searchParams.get('serviceAreaId'),
// //                 services: data
// //             })
// //         });

// //         console.log("✅ Data sent to API");
// //     } catch (err) {
// //         console.warn("⚠️ API failed:", err.message);
// //     }
// // })();
