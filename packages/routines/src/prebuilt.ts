// The four prebuilt routines (SPEC 9.7, harness 5.3 allowlists, harness 8). Checklists name code predicates in
// checks.ts; `{field}` templates read the trigger payload, then the precheck's derived values.
import type { RoutineDef } from "@weft/contracts";

export const TZ = "America/Los_Angeles";
export const OWNER = "usr_dana";
const budget = { steps: 6, usd: 0.1, minutes: 10 };

export const RT_AGENCY_NOTICE: RoutineDef = {
  id: "rt_agency_notice", name: "Agency notice handling",
  description: "When an agency notice arrives, read it, compute the impact, draft a reply and propose the rate change and the filing.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "event", event: "notice.received" }, filter: null,
  instructions: "Use the derived arguments. In one batch: draft the response with a one-sentence note, propose tax.update_rate with the derived arguments, and propose notices.send_response for the notice. Then write a short final message.",
  tools: ["notices.get", "tax.get_rates", "tax.rate_change_impact", "tax.update_rate", "notices.draft_response", "notices.send_response"],
  precheck: "agency_notice",
  checklist: [
    { id: "draft", label: "draft reply", check: "draft_exists:{notice_id}" },
    { id: "rate", label: "propose tax.update_rate", check: "proposal_exists:tax.update_rate:{notice_id}" },
    { id: "send", label: "propose notices.send_response", check: "proposal_exists:notices.send_response:{notice_id}" },
  ],
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
  description: "Every Monday at 9:00 PT, post headcount, hires, departures and pending approvals to #people-ops.",
  ownerPrincipalId: OWNER, enabled: true, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1", tz: TZ }, filter: null,
  instructions: "Post the digest text from the derived arguments to #people-ops with comms.send_message. Counts come from the precheck. Then write a one-line final message.",
  tools: ["comms.send_message", "people.search"],
  precheck: "people_digest",
  checklist: [{ id: "posted", label: "post the digest in #people-ops", check: "posted:#people-ops:{slot}" }],
  budget, surface: { worthSurfacing: false, channel: "#people-ops" }, source: "prebuilt", taintedBy: null,
};

export const PREBUILT: RoutineDef[] = [RT_AGENCY_NOTICE, RT_PRE_PAYROLL, RT_NEW_HIRE, RT_PEOPLE_DIGEST];
