console.log("INDEX>JS started");

import { routeAssignmentsFlow } from "./route-assignments.js";
import { weeklyScheduleFlow } from "./weekly-schedule.js";
import { workSummaryToolFlow } from "./work-summary-tool.js";

export const FLOW_REGISTRY = {
  [routeAssignmentsFlow.type]: routeAssignmentsFlow,
  [weeklyScheduleFlow.type]: weeklyScheduleFlow,
  [workSummaryToolFlow.type]: workSummaryToolFlow,
};
