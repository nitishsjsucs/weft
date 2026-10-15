// Round 2 fixtures (compliance, audit, routines, simulators, people). Contract-typed; fictional; ids follow the seed.
import { money, type Action, type ArmedFault, type ChatMessageDto, type EmployerRate, type Notice, type Offer, type OnboardingTask, type RoutineDef, type RoutineRunDto, type TaxAccount } from "@weft/contracts";

export function buildTax(): { accounts: TaxAccount[]; rates: EmployerRate[]; notices: Notice[] } {
  const acct = (id: string, jurisdiction: TaxAccount["jurisdiction"], agency: TaxAccount["agency"], accountType: TaxAccount["accountType"], accountNumber: string | null, status: TaxAccount["status"]): TaxAccount =>
    ({ id: id as `txa_${string}`, jurisdiction, agency, accountType, accountNumber, status, depositSchedule: jurisdiction === "US" ? "monthly" : null, registeredAt: status === "active" ? "2023-03-15T17:00:00.000Z" : null, simApplicationId: null });
  const rate = (id: string, jurisdiction: EmployerRate["jurisdiction"], code: EmployerRate["code"], r: string, base: number, from: string, to: string | null, source: string): EmployerRate =>
    ({ id: id as `etr_${string}`, jurisdiction, code, rate: r, wageBase: money(base), effectiveFrom: from, effectiveTo: to, source, createdActionSeq: null, supersededActionSeq: null });
  return {
    accounts: [
      acct("txa_us_federal", "US", "irs", "federal", "00-4817265", "active"),
      acct("txa_ca_combined", "CA", "ca_edd", "combined", "000-4817-2", "active"),
      acct("txa_ny_withholding", "NY", "ny_dtf", "withholding", "NY-48172-61", "active"),
      acct("txa_ny_ui", "NY", "ny_dol", "unemployment", "00-48172 6", "active"),
      acct("txa_tx_ui", "TX", "tx_twc", "unemployment", "00-481726-5", "active"),
    ],
    rates: [
      rate("etr_0001", "CA", "sui", "0.034", 700_000, "2026-01-01", null, "seed:2026 rate notice"),
      rate("etr_0002", "CA", "ett", "0.001", 700_000, "2026-01-01", null, "seed:2026 rate notice"),
      rate("etr_0003", "CA", "sui", "0.032", 700_000, "2025-01-01", "2025-12-31", "seed:history"),
      rate("etr_0004", "NY", "sui", "0.041", 1_760_000, "2026-01-01", null, "notice:ntc_0001"),
      rate("etr_0005", "TX", "sui", "0.027", 900_000, "2026-01-01", null, "seed:2026 rate notice"),
    ],
    notices: [{
      id: "ntc_0001", agency: "ny_dol", kind: "rate_change", formCode: "IA 96.1", title: "NY DOL (sim) 2026 unemployment insurance rate", receivedAt: "2026-02-14T15:00:00.000Z", respondBy: null,
      status: "resolved", taxAccountId: "txa_ny_ui", fileName: "NY_DOL_IA961_2026.txt",
      bodyText: "NEW YORK STATE DEPARTMENT OF LABOR (SIMULATED)\nUnemployment Insurance Division\n\nEmployer: Larkspur Robotics, Inc. (demo)\nRegistration number: 00-48172 6\n\nYour 2026 contribution rate is 4.1% on the first $17,600 of wages paid to each employee.\n\nThis is a synthetic notice generated for the Weft demo.",
      extracted: { agency: "ny_dol", formCode: "IA 96.1", kind: "rate_change", accountNumber: "00-48172 6", taxAccountId: "txa_ny_ui", taxYear: 2026, effectiveFrom: "2026-01-01", respondBy: null, rates: [{ code: "sui", oldRate: "0.041", newRate: "0.041" }], amountCents: null, period: null },
      resolution: { action: "no change needed" }, responseConfirmation: null,
    }],
  };
}

export function buildActions(): Action[] {
  const a = (seq: number, ts: string, actorKind: Action["actorKind"], actorId: string, command: string, summary: string, reversible: Action["reversible"], extra: Partial<Action> = {}): Action => ({
    seq, actionId: `act_${String(seq).padStart(4, "0")}` as `act_${string}`, ts, actorKind, actorId, onBehalfOf: null, agentRunId: null, routineRunId: null, proposalId: null, command, resultId: `res_${String(seq).padStart(4, "0")}`,
    summary, reversible, reversesSeq: null, reversedBySeq: null, notReversibleReason: null, prevHash: seq === 1 ? "0".repeat(64) : `h${seq - 1}`, hash: `h${seq}`, ...extra,
  });
  return [
    a(1, "2026-10-01T16:00:00.000Z", "system", "svc_scheduler", "payroll.mark_processed", "Processed payroll Sep 16 to Sep 30 (45 paychecks)", "na"),
    a(2, "2026-10-08T16:00:00.000Z", "human", "usr_sam", "people.update_title", "Updated title for Kaia Lockridge (demo)", "yes"),
    a(3, "2026-10-09T17:00:00.000Z", "human", "usr_dana", "people.update_pay_rate", "Raised Mireille Osterhout (demo) by 18% effective Oct 16", "yes"),
    a(4, "2026-10-15T13:00:00.000Z", "system", "svc_events", "payroll.mark_processed", "Processed payroll Oct 1 to Oct 15 (47 paychecks)", "na"),
    a(5, "2026-10-21T18:00:00.000Z", "agent", "agt_weft", "comms.send_message", "Posted the weekly people digest to #people-ops", "no", { onBehalfOf: "usr_dana", agentRunId: "run_0000", notReversibleReason: "message already delivered to the chat simulator" }),
  ];
}

export function buildRoutines(): { defs: RoutineDef[]; runs: RoutineRunDto[] } {
  const base = { ownerPrincipalId: "usr_dana", autonomy: "approve" as const, filter: null, precheck: null, source: "prebuilt" as const, taintedBy: null, budget: { steps: 6, usd: 0.1, minutes: 10 } };
  const defs: RoutineDef[] = [
    { ...base, id: "rt_agency_notice", name: "Agency notice handling", description: "Reads each agency notice, checks the impact against payroll, and proposes the rate change and a reply.", enabled: true, trigger: { type: "event", event: "notice.received" }, instructions: "Extract the notice, compute the impact, propose tax.update_rate and notices.send_response.", tools: ["notices.get", "tax.rate_change_impact", "tax.update_rate", "notices.send_response"], checklist: [{ id: "c1", label: "Draft exists", check: "draft_exists:{notice_id}" }, { id: "c2", label: "Rate change proposed", check: "proposal_exists:tax.update_rate:{notice_id}" }, { id: "c3", label: "Response proposed", check: "proposal_exists:notices.send_response:{notice_id}" }], surface: { worthSurfacing: true, channel: "#payroll" } },
    { ...base, id: "rt_pre_payroll", name: "Pre-payroll review", description: "On the approval deadline, explains every flagged paycheck and proposes submitting the run.", enabled: true, trigger: { type: "cron", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" }, instructions: "Explain each flagged paycheck from its evidence, then propose payroll.submit_run with exclude_blocked.", tools: ["payroll.get_run", "payroll.explain_flags", "payroll.submit_run"], checklist: [{ id: "c1", label: "Explanations complete", check: "explanations_complete:{run_id}" }, { id: "c2", label: "Submit proposed", check: "proposal_exists:payroll.submit_run:{run_id}" }], surface: { worthSurfacing: true, channel: "#payroll" } },
    { ...base, id: "rt_new_hire", name: "New hire readiness", description: "When an offer is accepted, creates accounts, welcomes the hire and proposes registrations and a laptop.", enabled: true, trigger: { type: "event", event: "offer.accepted" }, instructions: "Create accounts, post to #new-hires, propose state registrations and the device order.", tools: ["it.create_account", "comms.send_message", "tax.register_state_account", "it.order_device"], checklist: [{ id: "c1", label: "Accounts created", check: "accounts_created:{worker_id}" }, { id: "c2", label: "Welcome posted", check: "posted:#new-hires:{worker_id}" }], surface: { worthSurfacing: true, channel: "#new-hires" } },
    { ...base, id: "rt_people_digest", name: "Weekly people digest", description: "Every Monday at 09:00 PT posts headcount, hires, departures and open approvals to #people-ops.", enabled: true, trigger: { type: "cron", cron: "0 9 * * 1", tz: "America/Los_Angeles" }, instructions: "Post the digest from the precheck counts.", tools: ["comms.send_message"], checklist: [{ id: "c1", label: "Digest posted", check: "posted:#people-ops:{slot}" }], surface: { worthSurfacing: false, channel: "#people-ops" } },
  ];
  const runs: RoutineRunDto[] = [
    { id: "rtr_0000", routineId: "rt_people_digest", runKey: "k0", triggerRef: "cron 2026-10-19T09:00 PT", status: "done", agentRunId: null, summary: "Posted the digest: 48 employees, 2 hires in 30 days, 0 open approvals.", leftForHuman: [], overdue: false, attended: false, startedAt: "2026-10-19T16:00:00.000Z", endedAt: "2026-10-19T16:00:01.000Z", costUsdMicros: 0 },
    { id: "rtr_0001", routineId: "rt_agency_notice", runKey: "k1", triggerRef: "event notice.received ntc_0002", status: "waiting_approval", agentRunId: "run_0001", summary: "Two proposals are waiting in the Inbox.", leftForHuman: ["Approve the CA UI rate change", "Approve the response to CA EDD (sim)"], overdue: false, attended: true, startedAt: "2026-10-26T15:31:00.000Z", endedAt: null, costUsdMicros: 955 },
  ];
  return { defs, runs };
}

export function buildPeople(): { offers: Offer[]; onboarding: OnboardingTask[] } {
  return {
    offers: [{ id: "offr_0001", candidateFirst: "Noor", candidateLast: "Castellanos", candidateEmail: "noor.castellanos@mail.example", title: "Senior Firmware Engineer", departmentId: "dpt_hardware", workplaceId: "wkp_remote", workState: "CO", managerId: "wrk_0002", base: money(16_800_000), payKind: "salary", startDate: "2026-11-02", status: "sent", acceptedAt: null, workerId: null }],
    onboarding: [],
  };
}

export function buildSim(): { faults: ArmedFault[]; chat: ChatMessageDto[]; registrations: Record<string, unknown>[]; bankBatches: Record<string, unknown>[]; idpAccounts: Record<string, unknown>[] } {
  const msg = (id: string, channel: ChatMessageDto["channel"], author: string, text: string, ts: string): ChatMessageDto => ({ id, channel, author, text, card: null, ts, inbound: false });
  return {
    faults: [],
    chat: [
      msg("msg_0001", "#general", "Imani Ferreira (demo)", "Gripper v3 prototypes are in the Oakland lab if anyone wants a look.", "2026-10-23T18:00:00.000Z"),
      msg("msg_0002", "#people-ops", "Weft agent", "Weekly people digest: 48 employees, 2 hires in the last 30 days, 1 departure scheduled, 0 open approvals.", "2026-10-19T16:00:01.000Z"),
      msg("msg_0003", "#payroll", "Theo Marsh (demo)", "Oct 15 payroll settled with the sim bank. 47 paychecks.", "2026-10-15T13:05:00.000Z"),
      msg("msg_0004", "#new-hires", "Weft agent", "Welcome Rowan Achterberg (demo), Controls Engineer in Oakland, starting Oct 19.", "2026-10-19T16:30:00.000Z"),
    ],
    registrations: [{ id: "simr_0001", agency: "ca_edd", account_type: "combined", status: "active", account_number: "000-4817-2", completed_at: "2023-03-17T17:00:00.000Z" }],
    bankBatches: [{ id: "simb_2026_10_15", payroll_run_id: "pay_2026_10_15", total_cents: 18_212_440, status: "settled", settle_at: "2026-10-15T13:00:00.000Z", entryCount: 47 }],
    idpAccounts: [{ ref: "idp_0001", worker: "Dana Whitfield (demo)", system: "google_ws", handle: "dana.whitfield@larkspur.example", status: "active" }, { ref: "idp_0002", worker: "Dana Whitfield (demo)", system: "chat", handle: "@dana", status: "active" }, { ref: "idp_0003", worker: "Imani Ferreira (demo)", system: "github", handle: "imani-ferreira-demo", status: "active" }],
  };
}
