console.log("WEEKLY-SCHEDULE>JS started");

const FLOW_TYPE = "extract-weekly-schedule";
const DEFAULT_BASE_URL =
  "https://logistics.amazon.com/scheduling/calendar-view/week?date={date}&serviceAreaId={serviceAreaId}";
const SUBMIT_URL =
  "https://recon.amngtpro.com/api/functions/receiveWeeklyScheduleData";
//const SUBMIT_URL = "https://candidate-dashboard-integration.free.beeceptor.com";

function buildUrl({ baseUrl, date, serviceAreaId }) {
  return baseUrl
    .replace("{date}", date)
    .replace("{serviceAreaId}", serviceAreaId);
}

async function extractWeeklyScheduleInPage(context) {
  console.log("[weekly-schedule-page] Context:", context);
  console.log(
    "[weekly-schedule-page] window.location.href:",
    window.location.href,
  );
  console.log(
    "[weekly-schedule-page] window.location.search:",
    window.location.search,
  );
  console.log(
    "[weekly-schedule-page] window.location.hash:",
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

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getAttribute("aria-hidden") !== "true"
    );
  }

  function isTimeRangeText(value) {
    return /\b\d{1,2}:\d{2}(am|pm)\s*-\s*\d{1,2}:\d{2}(am|pm)\b/i.test(
      normalizeText(value),
    );
  }

  function findVoluntarySectionRoot() {
    const sectionTitle = Array.from(document.querySelectorAll("p")).find(
      (node) =>
        normalizeText(node.textContent).includes(
          "Voluntary extra time & time off",
        ),
    );

    if (!sectionTitle) {
      return null;
    }

    let current = sectionTitle.closest("div");
    while (current) {
      const next = current.nextElementSibling;
      if (next && next.querySelector('p[title*="@"] a[mdn-link]')) {
        return next;
      }
      current = current.parentElement?.closest("div") || null;
    }

    return null;
  }

  function findEmployeeRowRoots(sectionRoot) {
    const nameParagraphs = Array.from(
      sectionRoot.querySelectorAll('p[title*="@"]'),
    );

    const roots = [];
    const seen = new Set();

    nameParagraphs.forEach((paragraph) => {
      let current = paragraph.closest("div");

      while (current && current !== sectionRoot) {
        const emailCount = current.querySelectorAll('p[title*="@"]').length;
        const hasScheduleData = Array.from(
          current.querySelectorAll("p[title]"),
        ).some((node) => isTimeRangeText(node.getAttribute("title")));

        if (emailCount === 1 && hasScheduleData) {
          if (!seen.has(current)) {
            seen.add(current);
            roots.push(current);
          }
          return;
        }

        current = current.parentElement;
      }
    });

    return roots;
  }

  function getEmployeeName(rowRoot) {
    return normalizeText(
      rowRoot.querySelector('p[title*="@"] a')?.textContent || "",
    );
  }

  function getEmployeeIdentity(rowRoot) {
    return normalizeText(
      rowRoot.querySelector('p[title*="@"]')?.getAttribute("title") || "",
    );
  }

  function getDayCells(rowRoot) {
    const timeNodes = Array.from(rowRoot.querySelectorAll("p[title]")).filter(
      (node) => isTimeRangeText(node.getAttribute("title")),
    );

    const seen = new Set();
    const dayCells = [];

    timeNodes.forEach((timeNode) => {
      const dayCell =
        timeNode.closest("div[style*='position: relative']") ||
        timeNode.closest("div[style*='min-height: 64px']") ||
        timeNode.parentElement;

      if (dayCell && !seen.has(dayCell)) {
        seen.add(dayCell);
        dayCells.push(dayCell);
      }
    });

    return dayCells;
  }

  function getClickableEntryFromDayCell(dayCell) {
    const timeNode = Array.from(dayCell.querySelectorAll("p[title]")).find(
      (node) => isTimeRangeText(node.getAttribute("title")),
    );

    if (!timeNode) {
      return null;
    }

    const candidates = [
      timeNode.closest('[role="button"]'),
      timeNode.closest("button"),
      timeNode.closest("div[style*='justify-content']"),
      timeNode.closest("div[style*='position: relative']"),
      timeNode.parentElement,
      timeNode,
    ].filter(Boolean);

    return {
      timeNode,
      clickTarget: candidates[0],
      timeRange: normalizeText(
        timeNode.getAttribute("title") || timeNode.textContent,
      ),
    };
  }

  function clickEntry(entry) {
    entry.clickTarget.scrollIntoView?.({ block: "center", inline: "center" });
    if (typeof PointerEvent === "function") {
      entry.clickTarget.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    }
    entry.clickTarget.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    entry.clickTarget.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
    );
    if (typeof PointerEvent === "function") {
      entry.clickTarget.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
      );
    }
    entry.clickTarget.click?.();
  }

  function findPopupContainer() {
    const fallbackSelectors = [
      '[role="dialog"]',
      '[class*="popover"]',
      '[class*="Popper"]',
      '[class*="tooltip"]',
      '[class*="modal"]',
      '[class*="dialog"]',
      "[role='presentation']",
    ].join(",");
    const fallbackRoots = Array.from(
      document.querySelectorAll(fallbackSelectors),
    );
    const fallbackSearchRoots = fallbackRoots.length
      ? fallbackRoots
      : [document.body];
    const seen = new Set();
    const fallbackCandidates = [];

    fallbackSearchRoots.forEach((root) => {
      const nodes = root === document.body
        ? Array.from(root.children)
        : [root, ...Array.from(root.querySelectorAll("*"))];

      nodes.forEach((node) => {
        if (seen.has(node) || !isVisible(node)) return;
        seen.add(node);

        const text = normalizeText(node.textContent || "").toLowerCase();
        if (text.includes("hours worked")) {
          fallbackCandidates.push(node);
        }
      });
    });

    if (!fallbackCandidates.length) {
      return null;
    }

    return fallbackCandidates.sort(
      (left, right) =>
        normalizeText(left.textContent || "").length -
        normalizeText(right.textContent || "").length,
    )[0];
  }

  async function waitForPopupContainer(timeoutMs = 4000) {
    return new Promise((resolve) => {
      let settled = false;
      let settleTimeoutId = null;

      function finish(popup) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(settleTimeoutId);
        observer.disconnect();
        resolve(popup);
      }

      function checkForPopup() {
        const popup = findPopupContainer();
        if (popup) {
          finish(popup);
        }
      }

      const observer = new MutationObserver(() => {
        checkForPopup();
      });

      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });

      const popup = findPopupContainer();
      if (popup) {
        finish(popup);
        return;
      }

      settleTimeoutId = setTimeout(() => finish(null), timeoutMs);
    });
  }

  function extractHoursWorked(popup) {
    const paragraphs = Array.from(popup.querySelectorAll("p")).map((node) =>
      normalizeText(node.textContent || ""),
    );

    const labelIndex = paragraphs.findIndex((text) => text === "Hours Worked");
    if (labelIndex !== -1) {
      return paragraphs[labelIndex + 1] || "";
    }

    const popupText = normalizeText(popup.textContent || "");
    const hoursMatch = popupText.match(/hours worked\s*([\d.]+\s*h(?:r)?)/i);
    return normalizeText(hoursMatch?.[1] || "");
  }

  function findOpenPopupContainer() {
    return findPopupContainer();
  }

  async function closePopup(popupToClose = findOpenPopupContainer()) {
    if (!popupToClose) {
      return;
    }

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    await new Promise((resolve) => {
      let settled = false;
      let settleTimeoutId = null;

      function finish() {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(settleTimeoutId);
        observer.disconnect();
        resolve();
      }

      function isPopupClosed() {
        return !popupToClose.isConnected || !isVisible(popupToClose);
      }

      const observer = new MutationObserver(() => {
        if (isPopupClosed()) {
          finish();
        }
      });

      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });

      if (isPopupClosed()) {
        finish();
        return;
      }

      settleTimeoutId = setTimeout(finish, 1500);
    });
  }

  function extractDateHeaders() {
    const headerButtons = Array.from(
      document.querySelectorAll('button span[aria-label="Day options"]'),
    );

    return headerButtons.map((button) => {
      const container = button.closest("div.css-1ksidz3");
      const dateLink = container?.querySelector("a.css-153px2c");
      return normalizeText(dateLink?.textContent || "");
    });
  }

  function getColumnIndexFromCell(dayCell) {
    const columnContainer = dayCell.closest("div.css-1uuroi8");
    const parent = columnContainer?.parentElement;
    const columns = Array.from(
      parent?.querySelectorAll("div.css-1uuroi8") || [],
    );
    return columns.indexOf(columnContainer);
  }

  await waitForPageStability();
  console.log("[weekly-schedule-page] Page stabilized, starting extraction");

  const dateHeaders = extractDateHeaders();

  const sectionRoot = findVoluntarySectionRoot();
  if (!sectionRoot) {
    console.warn(
      "[weekly-schedule-page] Could not find 'Voluntary extra time & time off' section",
    );
    return {
      services: [],
    };
  }

  const employeeRows = findEmployeeRowRoots(sectionRoot);
  console.log(
    "[weekly-schedule-page] Employee rows detected in section:",
    employeeRows.length,
  );

  const collectedEntries = [];
  let openPopup = findOpenPopupContainer();

  for (const rowRoot of employeeRows) {
    const employeeName = getEmployeeName(rowRoot);
    const employeeIdentity = getEmployeeIdentity(rowRoot);
    const dayCells = getDayCells(rowRoot);

    console.log(
      "[weekly-schedule-page] Processing employee:",
      employeeName,
      employeeIdentity,
      `dayCells=${dayCells.length}`,
    );

    for (const [dayIndex, dayCell] of dayCells.entries()) {
      const entry = getClickableEntryFromDayCell(dayCell);
      if (!entry) {
        continue;
      }

      if (openPopup) {
        await closePopup(openPopup);
        openPopup = null;
      }

      clickEntry(entry);
      const popup = await waitForPopupContainer();

      if (!popup) {
        console.warn(
          "[weekly-schedule-page] Popup not detected for entry:",
          employeeName,
          `dayIndex=${dayIndex}`,
          entry.timeRange,
        );
        continue;
      }

      openPopup = popup;

      const columnIndex = getColumnIndexFromCell(dayCell);
      const record = {
        employeeName,
        employeeIdentity,
        date: dateHeaders[columnIndex] || "",
        hoursWorked: extractHoursWorked(popup),
        timeRange: entry.timeRange,
      };

      collectedEntries.push(record);

      if (collectedEntries.length % 25 === 0) {
        console.log(
          "[weekly-schedule-page] Collected weekly schedule entries:",
          collectedEntries.length,
        );
      }
    }
  }

  if (openPopup) {
    await closePopup(openPopup);
  }

  console.log(
    "[weekly-schedule-page] Final collected weekly schedule entry count:",
    collectedEntries.length,
  );

  // Group entries by employee
  const employees = employeeRows.map((rowRoot) => {
    const employeeName = getEmployeeName(rowRoot);
    const employeeIdentity = getEmployeeIdentity(rowRoot);
    const dayCells = getDayCells(rowRoot);

    const shifts = collectedEntries
      .filter((entry) => entry.employeeIdentity === employeeIdentity)
      .map((entry) => ({
        date: entry.date,
        hoursWorked: entry.hoursWorked,
        timeRange: entry.timeRange,
      }));

    return {
      employeeName,
      daysWorked: dayCells.length,
      shifts,
    };
  });

  const responseData = {
    number_of_employees: employeeRows.length,
    employees,
  };

  console.log(
    "[weekly-schedule-page] Final response summary:",
    {
      number_of_employees: responseData.number_of_employees,
      number_of_shifts: collectedEntries.length,
    },
  );

  return responseData;
}

function buildSubmission({ context, date, extractedData }) {
  console.log(
    "[weekly-schedule-submission] Building submission:",
    {
      date,
      serviceAreaId: context.serviceAreaId,
      employees: extractedData?.number_of_employees || 0,
    },
  );

  const submission = {
    url: SUBMIT_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
    },
    body: {
      date,
      serviceAreaId: context.serviceAreaId,
      ...extractedData,
    },
  };

  console.log(
    "[weekly-schedule-submission] Final submission summary:",
    {
      date: submission.body.date,
      serviceAreaId: submission.body.serviceAreaId,
      number_of_employees: submission.body.number_of_employees,
    },
  );

  return submission;
}

export const weeklyScheduleFlow = {
  type: FLOW_TYPE,
  defaultBaseUrl: DEFAULT_BASE_URL,
  postLoadDelayMs: 6000,
  betweenDatesDelayMs: 3000,
  matchesExpectedUrl: ({ currentUrl, date }) =>
    currentUrl.includes(`date=${date}`),
  buildUrl,
  extractInPage: extractWeeklyScheduleInPage,
  buildSubmission,
};
