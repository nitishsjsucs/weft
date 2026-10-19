// The four prebuilt routines (SPEC 9.7, harness 5.3 allowlists, harness 8). Checklists name code predicates in
// checks.ts; `{field}` templates read the trigger payload, then the precheck's derived values.
import type { RoutineDef } from "@weft/contracts";
import { routines as w2Onboarding } from "./wave2/onboarding";
import { routines as w2Benefits } from "./wave2/benefits";
import { routines as w2Memory } from "./wave2/memory";
import { routines as w3Expenses } from "./wave3/expenses";
import { routines as w3TimeOff } from "./wave3/time-off";
import { routines as w3Parity } from "./wave3/parity";
import { routines as w3IntegrationsHr } from "./wave3/integrations-hr";
import { routines as w3Screening } from "./wave3/screening";
import { routines as w4Compliance } from "./wave4/compliance";
import { routines as w4People } from "./wave4/people";
import { routines as w4Agent } from "./wave4/agent";
import { routines as w4Admin } from "./wave4/admin";
import { AGENCY_NOTICE_CHECKLIST, AGENCY_NOTICE_TOOLS } from "./agency-notice";

export const TZ = "America/Los_Angeles";
export const OWNER = "usr_dana";
const budget = { steps: 6, usd: 0.1, minutes: 10 };

/**
 * Every agency notice kind (wave 4 round 1, FG1): the precheck derives a plan (packages/routines/src/agency-notice.ts),
 * and the run gets that plan's tools and checklist items. A rate change keeps the GP1 batch; a missing filing replies
 * with the filing on record or prepares and proposes the return; a deposit schedule change is proposed; a penalty
 * gets an abatement reply and an escalation; anything unknown or uncertain is escalated with notices.escalate.
 */
export const RT_AGENCY_NOTICE: RoutineDef = {
  id: "rt_agency_notice", name: "Agency notice handling",
  description: "When an agency notice arrives, handle it by its kind: propose a rate change with a drafted reply, reply with the filing on record or prepare and propose a missing return, propose a deposit schedule change, request penalty abatement, or escalate it to the tax specialist.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "event", event: "notice.received" }, filter: null,
  instructions: "Follow the derived plan with the derived arguments, executable calls first, in one batch where you can: draft, prepare or escalate, then propose. For plan update_rate: draft the response with a one-sentence note, propose tax.update_rate and propose notices.send_response. For plan escalate, call notices.escalate with the derived arguments. If a procedure in <recall> says to escalate this kind of notice, escalate with notices.escalate instead of replying. Then write a short final message.",
  tools: [...AGENCY_NOTICE_TOOLS],
  precheck: "agency_notice",
  checklist: AGENCY_NOTICE_CHECKLIST,
  budget, surface: { worthSurfacing: true, channel: "#payroll" }, source: "prebuilt", taintedBy: null,
};

export const RT_PRE_PAYROLL: RoutineDef = {
  id: "rt_pre_payroll", name: "Pre-payroll review",
  description: "On the approval-deadline day of a draft pay run, explain every flagged paycheck from its evidence and propose submitting the run without blocked paychecks.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: "Read the flagged rows, then in one batch explain every flagged paycheck with payroll.explain_flags (quote only evidence amounts) and propose payroll.submit_run with the derived arguments. Then write a short final message.",
  tools: ["payroll.get_run", "people.get", "actions.list", "payroll.explain_flags", "payroll.submit_run", "agent.read_artifact"],
  precheck: "pre_payroll",
  checklist: [
    { id: "explain", label: "explain flagged paychecks", check: "explanations_complete:{run_id}" },
    { id: "submit", label: "propose payroll.submit_run", check: "proposal_exists:payroll.submit_run:{run_id}" },
  ],
  budget, surface: { worthSurfacing: true, channel: "#payroll" }, source: "prebuilt", taintedBy: null,
};

export const RT_NEW_HIRE: RoutineDef = {
  id: "rt_new_hire", name: "New hire readiness",
  description: "When an offer is accepted, create accounts, welcome the hire in #new-hires, and propose state registrations and the laptop.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "event", event: "offer.accepted" }, filter: null,
  instructions: "Use the derived arguments. Executable calls first: create the accounts and post the welcome in #new-hires; then propose the state registrations and the device order. Then write a short final message.",
  tools: ["people.get", "onboarding.get_checklist", "tax.list_registrations", "tax.register_state_account", "it.create_account", "it.order_device", "onboarding.complete_task", "comms.send_message"],
  precheck: "new_hire",
  checklist: [
    { id: "accounts", label: "create accounts", check: "accounts_created:{worker_id}" },
    { id: "welcome", label: "post in #new-hires", check: "posted:#new-hires:{worker_id}" },
    { id: "registrations", label: "propose state registrations", check: "registrations_proposed:{worker_id}:{register_count}" },
    { id: "device", label: "propose the laptop", check: "device_proposed:{worker_id}" },
  ],
  budget, surface: { worthSurfacing: true, channel: "#new-hires" }, source: "prebuilt", taintedBy: null,
};

export const RT_PEOPLE_DIGEST: RoutineDef = {
  id: "rt_people_digest", name: "Weekly people digest",
  description: "Every Monday at 9:00 AM PT, post headcount, hires, departures and pending approvals to #people-ops.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1", tz: TZ }, filter: null,
  instructions: "Post the digest text from the derived arguments to #people-ops with comms.send_message. Counts come from the precheck. Then write a one-line final message.",
  tools: ["comms.send_message", "people.search"],
  precheck: "people_digest",
  checklist: [{ id: "posted", label: "post the digest in #people-ops", check: "posted:#people-ops:{slot}" }],
  budget, surface: { worthSurfacing: false, channel: "#people-ops" }, source: "prebuilt", taintedBy: null,
};

export const PREBUILT: RoutineDef[] = [RT_AGENCY_NOTICE, RT_PRE_PAYROLL, RT_NEW_HIRE, RT_PEOPLE_DIGEST, ...w2Onboarding, ...w2Benefits, ...w2Memory, ...w3Expenses, ...w3TimeOff, ...w3Parity, ...w3IntegrationsHr, ...w3Screening, ...w4Compliance, ...w4People, ...w4Agent, ...w4Admin];
