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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function findWeekHeader() {
    const weekLabel = Array.from(document.querySelectorAll("p")).find((node) =>
      /^Week\s+\d+:?$/i.test(normalizeText(node.textContent)),
    );

    if (!weekLabel) {
      return null;
    }

    const weekRange = weekLabel.parentElement
      ? Array.from(weekLabel.parentElement.querySelectorAll("p")).find(
          (node) =>
            node !== weekLabel &&
            /^[A-Z][a-z]{2}\s+\d{2}\s+-/i.test(normalizeText(node.textContent)),
        )
      : null;

    return {
      week: normalizeText(weekLabel.textContent),
      range: normalizeText(weekRange?.textContent || ""),
    };
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
      serviceHint: normalizeText(
        Array.from(dayCell.querySelectorAll("p[title]"))
          .find((node) => !isTimeRangeText(node.getAttribute("title")))
          ?.getAttribute("title") || "",
      ),
    };
  }

  async function clickEntry(entry) {
    entry.clickTarget.click?.();
    entry.clickTarget.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await sleep(1000);
  }

  function findPopupContainer() {
    const allDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));

    const dialogCandidates = allDialogs.filter((node) => {
      if (!isVisible(node)) return false;
      const text = normalizeText(node.innerText || "").toLowerCase();
      return (
        text.includes("hours worked") &&
        text.includes("based on flex:") &&
        text.includes("work block") &&
        text.includes("shift")
      );
    });

    if (dialogCandidates.length) {
      return dialogCandidates.sort(
        (left, right) =>
          normalizeText(left.innerText || "").length -
          normalizeText(right.innerText || "").length,
      )[0];
    }

    const allBodyElements = Array.from(document.querySelectorAll("body *"));
    console.log(
      "[weekly-schedule-page] All body elements checked:",
      allBodyElements.length,
    );

    const fallbackCandidates = allBodyElements.filter((node) => {
      if (!isVisible(node)) return false;
      const text = normalizeText(node.innerText || "").toLowerCase();
      return (
        text.includes("hours worked") &&
        text.includes("based on flex:") &&
        text.includes("work block") &&
        text.includes("shift")
      );
    });

    console.log(
      "[weekly-schedule-page] Fallback candidates after filter:",
      fallbackCandidates.length,
    );
    fallbackCandidates.forEach((c, i) =>
      console.log(`Fallback ${i} text:`, normalizeText(c.innerText || "")),
    );

    if (!fallbackCandidates.length) {
      return null;
    }

    return fallbackCandidates.sort(
      (left, right) =>
        normalizeText(left.innerText || "").length -
        normalizeText(right.innerText || "").length,
    )[0];
  }

  async function waitForPopupContainer(timeoutMs = 10000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const popup = findPopupContainer();
      if (popup) {
        return popup;
      }
      await sleep(200);
    }

    return null;
  }

  function extractValueFromPopupText(popupText, label, nextLabel) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedNextLabel = nextLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `${escapedLabel}\\s*(.*?)\\s*${escapedNextLabel}`,
      "is",
    );
    const match = popupText.match(regex);
    return normalizeText(match?.[1] || "");
  }

  function extractPopupData(popup) {
    const paragraphs = Array.from(popup.querySelectorAll("p")).map((node) =>
      normalizeText(node.textContent || ""),
    );
    const popupText = normalizeText(popup.innerText || "");

    function valueAfter(label) {
      const index = paragraphs.findIndex((text) => text === label);
      if (index === -1) {
        return "";
      }
      return paragraphs[index + 1] || "";
    }

    function valueStartingWith(prefix) {
      return (
        paragraphs.find((text) =>
          text.toLowerCase().startsWith(prefix.toLowerCase()),
        ) || ""
      );
    }

    const result = {
      hoursWorked: valueAfter("Hours Worked"),
      basedOnFlex: valueStartingWith("Based on Flex:").replace(
        /^Based on Flex:\s*/i,
        "",
      ),
      workBlock: valueAfter("Work Block"),
      shift: valueAfter("Shift"),
      popupText,
    };

    return result;
  }

  async function closePopup() {
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
    await sleep(300);
  }

  function extractDateHeaders() {
    const headerButtons = Array.from(
      document.querySelectorAll('button span[aria-label="Day options"]'),
    );

    const dates = headerButtons.map((button) => {
      const container = button.closest("div.css-1ksidz3");
      const dateLink = container?.querySelector("a.css-153px2c");
      return normalizeText(dateLink?.textContent || "");
    });

    console.log("[weekly-schedule-page] Extracted date headers:", dates);
    return dates;
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

  const weekHeader = findWeekHeader();
  console.log("[weekly-schedule-page] Week header:", weekHeader);

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

      // Ensure no previous popup is lingering
      await closePopup();

      await clickEntry(entry);
      await sleep(600);
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

      const popupData = extractPopupData(popup);
      const columnIndex = getColumnIndexFromCell(dayCell);
      const date = dateHeaders[columnIndex] || "";

      const record = {
        employeeName,
        employeeIdentity,
        date,
        dayIndex,
        timeRange: entry.timeRange,
        serviceHint: entry.serviceHint || null,
        ...popupData,
      };

      collectedEntries.push(record);
      console.log("[weekly-schedule-page] Collected entry:", record);

      await closePopup();
    }
  }

  console.log(
    "[weekly-schedule-page] Final collected weekly schedule entries:",
    collectedEntries,
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
        workBlock: entry.workBlock,
        shift: entry.shift,
      }));

    return {
      employeeName,
      daysWorked: dayCells.length,
      daysIncomplete: null,
      shifts,
    };
  });

  const responseData = {
    week: weekHeader?.week || "",
    week_date_range: weekHeader?.range || "",
    number_of_employees: employeeRows.length,
    employees,
  };

  console.log(
    "[weekly-schedule-page] Final response data to be sent:",
    responseData,
  );

  return responseData;
}

function buildSubmission({ context, date, extractedData }) {
  console.log(
    "[weekly-schedule-submission] Building submission with extractedData:",
    extractedData,
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
    "[weekly-schedule-submission] Final submission body:",
    submission.body,
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
