// The w4-parity-people read surface for apps/api (life events, windows, carrier submissions, check-ins).
// Writes always go through the executor as commands (commands/w4-people.ts); these are reads and the sweep's due check.
export { LIFE_EVENT_RULES, lifeEventRule, windowFor, reminderDates, addDays, REMINDER_DAYS_BEFORE_CLOSE, type LifeEventRule } from "./rules";
export { listLifeEvents, listWindows, noteFor, remindersDue, sweepPlan, submissionsFor, workerOfPrincipal, type LifeEventDto, type WindowDto } from "./windows";
export { CHECKIN_QUESTIONS, checkinsFor, directReports, managerSummaryW4, type CheckinView } from "./checkin-form";
export { outThisWeek, weekOf, describeDays, requestablePolicies, firstDayPlan, firstDayEmails, FIRST_DAY_TEAM_CAP, type OutThisWeek, type FirstDayPlan, type FirstDayHire } from "./people-week";
export { liveOpenEnrollment, openEnrollmentDates, OPEN_ENROLLMENT_MAX_DAYS, planYearOf } from "./open-enrollment";
export { addWorkingDays } from "./business-days";
