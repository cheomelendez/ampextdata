console.log("WORK-SUMMARY>JS started");

const FLOW_TYPE = "extract-work-summary-tool-data";
const DEFAULT_BASE_URL =
  "https://logistics.amazon.com/harmony/v2/#!/dsp-portal?serviceAreaId={serviceAreaId}&localDate={date}";
const SUBMIT_URL =
  "https://recon.amngtpro.com/api/functions/receiveWorkSummaryData";
//const SUBMIT_URL = "https://candidate-dashboard-integration.free.beeceptor.com";

function buildUrl({ baseUrl, date, serviceAreaId }) {
  return baseUrl
    .replace("{date}", date)
    .replace("{serviceAreaId}", serviceAreaId);
}

async function extractWorkSummaryToolInPage(context) {
  console.log("[work-summary-page] Context:", context);
  console.log(
    "[work-summary-page] window.location.href:",
    window.location.href,
  );
  console.log(
    "[work-summary-page] window.location.search:",
    window.location.search,
  );
  console.log(
    "[work-summary-page] window.location.hash:",
    window.location.hash,
  );

  function waitForPageStability() {
    return new Promise((resolve) => {
      let timeoutId = null;

      const observer = new MutationObserver(() => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1000);
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 8000);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseNumber(value) {
    const normalizedValue = (value || "").replace(/,/g, "").trim();
    const parsed = Number(normalizedValue);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeLabel(value) {
    return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    if (element.classList.contains("ng-hide")) {
      return false;
    }

    if (element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function extractQuantityValues(container) {
    const valuesByLabel = {};
    const quantityBlocks = Array.from(
      container.querySelectorAll(".fwt-quantityBlock"),
    );

    quantityBlocks.forEach((block) => {
      const valueText =
        block.querySelector(".fwt-quantityBlock-top")?.textContent || "";
      const labelText =
        block.querySelector(".fwt-quantityBlock-bottom")?.textContent || "";
      const normalizedLabel = normalizeLabel(labelText);

      if (!normalizedLabel) {
        return;
      }

      valuesByLabel[normalizedLabel] = parseNumber(valueText);
    });

    return valuesByLabel;
  }

  function formatHourDuration(hours) {
    const normalizedHours = Number(hours);
    const displayHours = Number.isInteger(normalizedHours)
      ? String(normalizedHours)
      : String(normalizedHours).replace(/\.0$/, "");

    return `${displayHours} ${normalizedHours === 1 ? "Hour" : "Hours"}`;
  }

  function buildEmptyRoute(service) {
    return {
      service,
      type: null,
      duration: null,
      deliveredPackages: null,
      pickupPackages: null,
      dspLateCancel: null,
      amzLateCancel: null,
      completedRoutes: null,
    };
  }

  function getTrainingEventRows(holder) {
    return Array.from(holder.querySelectorAll(".fwt-listBoxItem")).filter(
      (row) =>
        isVisible(row) && /total duration\s*:/i.test(row.textContent || ""),
    );
  }

  function parseTrainingDurationHours(row) {
    const durationText =
      Array.from(row.querySelectorAll(".ng-binding"))
        .map((node) => node.textContent || "")
        .find((text) => /total duration\s*:/i.test(text)) ||
      row.textContent ||
      "";
    const durationMatch = durationText.match(
      /total duration\s*:\s*([\d.]+)\s*(?:hr|hour)s?\b/i,
    );

    if (!durationMatch) {
      return null;
    }

    const hours = Number(durationMatch[1]);
    return Number.isFinite(hours) ? hours : null;
  }

  async function expandTrainingHolder(holder) {
    if (getTrainingEventRows(holder).length > 0) {
      return;
    }

    const expandTarget =
      holder.querySelector(".fwt-listBoxHeading .fwt-expand-collapse") ||
      holder.querySelector(".fwt-listBoxHeading [ng-click*='expanded']") ||
      holder.querySelector(".fwt-listBoxHeading");

    if (!expandTarget) {
      console.warn("[work-summary-page] Training expand target not found");
      return;
    }

    expandTarget.click();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);

      if (getTrainingEventRows(holder).length > 0) {
        return;
      }
    }
  }

  async function extractTrainingRoutes(holder) {
    await expandTrainingHolder(holder);

    const countsByHours = new Map();
    getTrainingEventRows(holder).forEach((row) => {
      const hours = parseTrainingDurationHours(row);

      if (hours === null) {
        return;
      }

      countsByHours.set(hours, (countsByHours.get(hours) || 0) + 1);
    });

    if (countsByHours.size === 0) {
      console.warn("[work-summary-page] Training rows found without durations");
      return [buildEmptyRoute("Training")];
    }

    return Array.from(countsByHours.entries())
      .sort(([leftHours], [rightHours]) => rightHours - leftHours)
      .map(([hours, completedRoutes]) => ({
        service: "Training",
        type: null,
        duration: formatHourDuration(hours),
        deliveredPackages: null,
        pickupPackages: null,
        dspLateCancel: null,
        amzLateCancel: null,
        completedRoutes,
      }));
  }

  function parseRouteHeading(headingText) {
    const normalizedHeading = (headingText || "").replace(/\s+/g, " ").trim();

    if (!normalizedHeading) {
      return {
        service: null,
        type: null,
        duration: null,
      };
    }

    if (/^excluded services$/i.test(normalizedHeading)) {
      return {
        service: "Excluded Services",
        type: null,
        duration: null,
      };
    }

    if (/^training$/i.test(normalizedHeading)) {
      return {
        service: "Training",
        type: null,
        duration: null,
      };
    }

    const durationMatch = normalizedHeading.match(/(\d+)\s*hr\b/i);
    const duration = durationMatch ? `${durationMatch[1]} Hours` : null;

    let cleaned = normalizedHeading;
    if (durationMatch) {
      cleaned = cleaned.replace(durationMatch[0], "");
    }

    cleaned = cleaned
      .replace(/\s*-\s*/g, " - ")
      .replace(/-\s*$/, "")
      .replace(/^\s*-\s*/, "")
      .trim();

    const parts = cleaned
      .split(" - ")
      .map((part) => part.trim())
      .filter(Boolean);

    function isVehicleSegment(segment) {
      return /(van|step van|vehicle)/i.test(segment);
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
      service: serviceParts.length
        ? serviceParts.join(" - ")
        : normalizedHeading,
      type: remainingParts.length ? remainingParts.join(" - ") : null,
      duration,
    };
  }

  function extractHeader() {
    const headerRoot = document.querySelector("#fwt-dspReviewHeader");
    if (!headerRoot) {
      console.warn("[work-summary-page] Header root not found");
      return {
        totalPackages: 0,
        deliveredPackages: 0,
        pickupPackages: 0,
        completedRoutes: 0,
        miles: 0,
      };
    }

    const valuesByLabel = extractQuantityValues(headerRoot);

    const header = {
      totalPackages: valuesByLabel["total packages"] ?? 0,
      deliveredPackages: valuesByLabel["delivered packages"] ?? 0,
      pickupPackages: valuesByLabel["pickup packages"] ?? 0,
      completedRoutes: valuesByLabel["completed routes"] ?? 0,
      miles: valuesByLabel["miles"] ?? 0,
    };

    console.log("[work-summary-page] Extracted header:", header);
    return header;
  }

  async function extractRoutes() {
    const routeListContainer = document.querySelector(
      `div[ng-include="'routeList.html'"]`,
    );

    if (!routeListContainer) {
      console.warn("[work-summary-page] Route list container not found");
      return [];
    }

    const routeHolders = Array.from(
      routeListContainer.querySelectorAll(".fwt-listBox.workSheetHolder"),
    ).filter(isVisible);

    const routes = [];

    for (const holder of routeHolders) {
      const headingText =
        holder.querySelector(".fwt-listBoxHeading h4")?.textContent || "";
      const parsedHeading = parseRouteHeading(headingText);

      if (/^training$/i.test(parsedHeading.service || "")) {
        routes.push(...(await extractTrainingRoutes(holder)));
        continue;
      }

      if (/^excluded services$/i.test(parsedHeading.service || "")) {
        routes.push(buildEmptyRoute(parsedHeading.service));
        continue;
      }

      const dataRow = holder.querySelector(".fwt-data-row");
      if (!dataRow) {
        continue;
      }

      const valuesByLabel = extractQuantityValues(dataRow);

      routes.push({
        service: parsedHeading.service,
        type: parsedHeading.type,
        duration: parsedHeading.duration,
        deliveredPackages: valuesByLabel["delivered packages"] ?? 0,
        pickupPackages: valuesByLabel["pickup packages"] ?? 0,
        dspLateCancel: valuesByLabel["dsp late cancel"] ?? 0,
        amzLateCancel: valuesByLabel["amzl late cancel"] ?? 0,
        completedRoutes: valuesByLabel["completed routes"] ?? 0,
      });
    }

    console.log("[work-summary-page] Extracted routes:", routes);
    return routes;
  }

  await waitForPageStability();
  console.log(
    "[work-summary-page] Page stabilized, extracting header and routes",
  );

  return {
    header: extractHeader(),
    routes: await extractRoutes(),
  };
}

function buildSubmission({ context, date, extractedData, url }) {
  return {
    url: SUBMIT_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
    },
    body: {
      date,
      serviceAreaId: context.serviceAreaId,
      header: extractedData?.header || {},
      services: extractedData?.routes || [],
    },
  };
}

export const workSummaryToolFlow = {
  type: FLOW_TYPE,
  defaultBaseUrl: DEFAULT_BASE_URL,
  postLoadDelayMs: 6000,
  betweenDatesDelayMs: 3000,
  matchesExpectedUrl: ({ currentUrl, date }) =>
    currentUrl.includes(`localDate=${date}`),
  buildUrl,
  extractInPage: extractWorkSummaryToolInPage,
  buildSubmission,
};
