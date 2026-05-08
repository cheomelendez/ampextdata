console.log("ROUTE-ASSIGNMENT>JS started");

const FLOW_TYPE = "extract-route-assignments-data";
const DEFAULT_BASE_URL =
  "https://logistics.amazon.com/scheduling?serviceAreaId={serviceAreaId}&date={date}";
const SUBMIT_URL = "https://recon.amngtpro.com/api/functions/receiveRouteData";
//const SUBMIT_URL = "https://candidate-dashboard-integration.free.beeceptor.com";

function buildUrl({ baseUrl, date, serviceAreaId }) {
  return baseUrl
    .replace("{date}", date)
    .replace("{serviceAreaId}", serviceAreaId);
}

async function extractRouteAssignmentsInPage(context) {
  console.log("[route-assignments-page] Context:", context);
  console.log(
    "[route-assignments-page] window.location.href:",
    window.location.href,
  );
  console.log(
    "[route-assignments-page] window.location.search:",
    window.location.search,
  );
  console.log(
    "[route-assignments-page] window.location.hash:",
    window.location.hash,
  );

  function parseRow(row) {
    const rowContainer = row.closest(".row");

    if (
      !rowContainer ||
      rowContainer.style.display === "none" ||
      getComputedStyle(rowContainer).display === "none"
    ) {
      return null;
    }

    const headerEl = row.querySelector(".rowHeader");
    const headerText = headerEl?.querySelector("span")?.innerText?.trim() || "";
    const fullRowText = row.innerText || "";
    const dataFields = row.querySelectorAll(".rowHeaderData");

    const confirmed = Number(
      dataFields[0]?.querySelector("span")?.innerText || 0,
    );
    const rostered = Number(
      dataFields[1]?.querySelector("span")?.innerText || 0,
    );

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
        rostered: 0,
      };
    }

    const durationMatch = headerText.match(/(\d+\s*Hours?)/i);
    const duration = durationMatch ? durationMatch[1] : null;

    let station = null;
    const stationMatch = headerText.match(/-\s*([^-\n]*station[^-\n]*)/i);
    if (stationMatch) {
      station = stationMatch[1].trim();
    }

    let cleaned = headerText;

    if (duration) {
      cleaned = cleaned.replace(duration, "");
    }

    if (station) {
      cleaned = cleaned.replace(`- ${station}`, "");
    }

    cleaned = cleaned.replace(/\d+\s*Confirmed/i, "");
    cleaned = cleaned.replace(/\d+\s*Rostered/i, "");
    cleaned = cleaned
      .replace(/\s*-\s*/g, " - ")
      .replace(/-\s*$/, "")
      .replace(/^\s*-\s*/, "")
      .trim();

    const parts = cleaned
      .split(" - ")
      .map((part) => part.trim().replace(/-$/, "").trim())
      .filter(Boolean);

    function isVehicleSegment(segment) {
      return /(Van|Step Van|Vehicle)/i.test(segment);
    }

    const serviceParts = [];
    const remainingParts = [];

    parts.forEach((segment, index) => {
      if (index === 0 || isVehicleSegment(segment)) {
        serviceParts.push(segment);
      } else {
        remainingParts.push(segment);
      }
    });

    return {
      service: serviceParts.length ? serviceParts.join(" - ") : null,
      type: remainingParts.length ? remainingParts.join(" - ") : null,
      station,
      duration,
      confirmed,
      rostered,
    };
  }

  function extract() {
    const container = document.querySelector("#confirmedServiceRequestSection");
    if (!container) {
      console.warn("Route assignments container not found");
      return [];
    }

    const rows = container.querySelectorAll(".rowHeaderContainer");
    return Array.from(rows).map(parseRow).filter(Boolean);
  }

  function waitForUI() {
    return new Promise((resolve) => {
      if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
        resolve();
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.querySelectorAll(".rowHeaderContainer").length > 0) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 10000);
    });
  }

  await waitForUI();
  console.log("[route-assignments-page] UI ready, starting extraction");
  return extract();
}

function buildSubmission({ context, date, extractedData }) {
  return {
    url: SUBMIT_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
    },
    body: {
      date,
      serviceAreaId: context.serviceAreaId,
      services: extractedData,
    },
  };
}

export const routeAssignmentsFlow = {
  type: FLOW_TYPE,
  defaultBaseUrl: DEFAULT_BASE_URL,
  postLoadDelayMs: 4000,
  betweenDatesDelayMs: 5000,
  matchesExpectedUrl: ({ currentUrl, date }) => currentUrl.includes(`date=${date}`),
  buildUrl,
  extractInPage: extractRouteAssignmentsInPage,
  buildSubmission,
};
