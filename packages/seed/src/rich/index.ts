// The "rich" seed profile: a deterministic layer on top of seedWorld() that fills history and motion so every screen
// has data (WEFT_SEED_PROFILE=rich, the default for `pnpm dev`). Tests, `pnpm e2e`, `pnpm demo` and the eval worlds
// keep the base profile, so their digests and golden numbers never see this layer.
//
// Rules: it only adds rows, never edits a planted row (the four pay runs, Ruth's coverage conflict, the 8 expenses in
// review, the DE 2088 flow, Noor's offer, the open October reconciliation). Ids come from the same id counters the app
// uses, timestamps are fixed sim-clock instants before the seed time, every domain is *.example, and nothing here
// calls a model. The agent's runs are real: the showcase runs (./showcase.ts), recorded once on the live model by
// `pnpm seed:record-showcase`, are replayed as the last step, on exactly the world this layer builds before them.
import { and, asc, eq } from "drizzle-orm";
import { PREBUILT } from "@weft/routines";
import {
  actions, benefitEnrollments, enrollmentWindows, itAccounts, lifeEvents, approvalAudit, contractorPayments, documents, employerTaxRates, filings, handoffCases, notices, offboardingCases, offboardingSteps,
  complianceItems, expensePolicies, onboardingTasks, paychecks, payRates, payrollRuns, proposals, simAgencyMail, simChatMessages, simRailTransfers, simRegistrations,
  taxAccounts, taxProfiles, timeOffAssignments, timeOffLedger, timeOffRequests, workers, withWriteLock, type DbTx,
} from "@weft/db";
import { canonicalJson, commands, newId, offboarding, payroll, sha256Hex } from "@weft/core";
import { EXPENSE_RATES, type ExecContext, type Preview, type SimClock, type Simulators } from "@weft/contracts";
import { createSimulators } from "@weft/sim";
import type { SeedContext } from "../context";
import { seedRichMotion, type MotionApi } from "./motion";
import { seedBlobMode } from "../blobs";
import { seedImportedPayHistory } from "./pay-history";
import { enrollLeaver, seedTurnover, terminateLeaverEnrollments } from "./turnover";
import { SEED_CHAT } from "../it";
import { applyShowcaseFiles, applyShowcaseMemory, applyShowcaseRows, readShowcaseFixture } from "./showcase";

const CO = "cmp_larkspur";
const GENESIS = "0".repeat(64);
const AGENT = "agt_weft";
type W = typeof workers.$inferSelect;

/** Deterministic pseudo random numbers (no faker draw, so the base seed's faker sequence is untouched). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 0x1_0000_0000; };
}
const pt = (date: string, hour: number, minute = 0) => payroll.ptToUtc(date, hour, minute);
const name = (w: Pick<W, "firstName" | "lastName">) => `${w.firstName} ${w.lastName}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const isWeekday = (d: string) => weekday(d) !== 0 && weekday(d) !== 6;
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"]);

/** Counts written by the layer, for the CLI log and the tests. */
export interface RichSummary { [table: string]: number }

// ---- proposals and the action log ----------------------------------------------------------------------------------

interface PendingAction {
  ts: string; actorKind: "human" | "agent" | "routine" | "system"; actorId: string; onBehalfOf?: string | null; agentRunId?: string | null;
  routineRunId?: string | null; proposalId?: string | null; command: string; args: Record<string, unknown>; summary: string;
  reversible?: "yes" | "no" | "na"; reverse?: unknown; reverses?: string; key?: string;
}

class Layer {
  readonly counts: RichSummary = {};
  readonly pending: PendingAction[] = [];
  constructor(readonly tx: DbTx, private readonly sims: Simulators | null = null, private readonly clock: SimClock | null = null) {}
  bump(t: string, n = 1) { this.counts[t] = (this.counts[t] ?? 0) + n; }

  /** The command's own preview and risk class, so a planted proposal reads exactly like a live one for the same call. */
  async preview(command: string, args: Record<string, unknown>): Promise<Preview & { risk: string }> {
    const cmd = commands.find((c) => c.name === command);
    if (!cmd?.preview || !this.sims || !this.clock) throw new Error(`rich seed: no preview for ${command}`);
    const input = cmd.input.parse(args);
    const ctx: ExecContext = { companyId: CO, principal: { id: "usr_dana", kind: "human", role: "owner" }, onBehalfOf: null, surface: "human_ui", agentKind: null,
      run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: this.clock.now() };
    const deps = { tx: this.tx, sims: this.sims, clock: this.clock, newId: (prefix: string) => newId(this.tx, prefix as Parameters<typeof newId>[1]),
      resolveCredential: async () => { throw new Error("rich seed: previews never read the vault"); } };
    return { ...(await cmd.preview(input, ctx, deps as never)), risk: cmd.risk(input) };
  }

  /** The command's own risk class for these arguments. */
  risk(command: string, args: Record<string, unknown>): string {
    const cmd = commands.find((c) => c.name === command);
    if (!cmd) throw new Error(`rich seed: no command ${command}`);
    return cmd.risk(cmd.input.parse(args));
  }

  /** Runs a read command (R0) as Vic would, so a planted post quotes the figures the live tool returns. */
  async read<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const cmd = commands.find((c) => c.name === command);
    if (!cmd || cmd.effect !== "read" || !this.sims || !this.clock) throw new Error(`rich seed: ${command} is not a read`);
    const ctx: ExecContext = { companyId: CO, principal: { id: "usr_dana", kind: "human", role: "owner" }, onBehalfOf: null, surface: "human_ui", agentKind: null,
      run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: this.clock.now() };
    const deps = { tx: this.tx, sims: this.sims, clock: this.clock, newId: (prefix: string) => newId(this.tx, prefix as Parameters<typeof newId>[1]),
      resolveCredential: async () => { throw new Error("rich seed: reads never touch the vault"); } };
    return (await cmd.run(cmd.input.parse(args), ctx, deps as never)).data as T;
  }

  async proposal(p: {
    at: string; command: string; args: Record<string, unknown>; subjectRef: string; risk: string; headline: string; domain: string; moneyCents?: number;
    diff?: { label: string; before: string; after: string }[]; evidence?: { label: string; ref: string }[]; agentNote?: string | null; kind?: "action" | "suggestion";
    runId?: string | null; routineRunId?: string | null; status: "pending" | "executed" | "denied" | "dismissed"; decidedBy?: string; decidedAt?: string;
    decisionCode?: string | null; decisionNote?: string | null; reversible?: boolean; expiresAt?: string; onBehalfOf?: string | null;
    exec?: Omit<PendingAction, "proposalId" | "command" | "args"> & { command?: string };
  }): Promise<string> {
    const id = await newId(this.tx, "prp_");
    const argsHash = sha256Hex(canonicalJson(p.args));
    // The risk class is always the command's own for these arguments, never a hand-written one.
    const risk = commands.some((c) => c.name === p.command) ? this.risk(p.command, p.args) : p.risk;
    await this.tx.insert(proposals).values({
      id, companyId: CO, kind: p.kind ?? "action", command: p.command, argsJson: JSON.stringify(p.args), argsHash, subjectRef: p.subjectRef,
      subjectHash: null, risk, headline: p.headline, diffJson: JSON.stringify(p.diff ?? []), contentJson: "[]", evidenceJson: JSON.stringify(p.evidence ?? []),
      agentNote: p.agentNote ?? null, proposerRunId: p.runId ?? null, routineRunId: p.routineRunId ?? null, onBehalfOf: p.onBehalfOf ?? "usr_dana", domain: p.domain,
      moneyCents: p.moneyCents ?? null, reversible: p.reversible ?? false, createdAt: p.at,
      expiresAt: p.expiresAt ?? new Date(Date.parse(p.at) + 3 * 86_400_000).toISOString(), status: p.status,
      decidedBy: p.decidedBy ?? null, decidedAt: p.decidedAt ?? null, decisionCode: p.decisionCode ?? null, decisionNote: p.decisionNote ?? null, executedActionSeq: null,
    });
    this.bump("proposals");
    if (p.status !== "pending" && p.decidedBy && p.decidedAt) {
      const attempt = p.status === "executed" ? "approve" : p.status === "denied" ? "deny" : "dismiss";
      this.audits.push({ proposalId: id, principalId: p.decidedBy, attempt, outcome: "ok", ts: p.decidedAt });
    }
    if (p.status === "executed" && p.exec) {
      this.pending.push({ ...p.exec, command: p.exec.command ?? p.command, args: p.args, proposalId: id, key: id });
    }
    return id;
  }
  readonly audits: { proposalId: string; principalId: string; attempt: string; outcome: string; ts: string }[] = [];

  action(a: PendingAction) { this.pending.push(a); }

  /** Appends every pending action in time order after the current chain head, then links executed proposals. */
  async flushActions(): Promise<{ seq: number; hash: string; ts: string; command: string; summary: string }[]> {
    const { tx } = this;
    const [head] = await tx.select({ seq: actions.seq, hash: actions.hash }).from(actions).orderBy(asc(actions.seq));
    const all = await tx.select({ seq: actions.seq, hash: actions.hash }).from(actions).orderBy(asc(actions.seq));
    let seq = all.at(-1)?.seq ?? 0;
    let prev = all.at(-1)?.hash ?? head?.hash ?? GENESIS;
    const byKey = new Map<string, number>();
    const out: { seq: number; hash: string; ts: string; command: string; summary: string }[] = [];
    const sorted = [...this.pending].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const a of sorted) {
      seq += 1;
      const actionId = await newId(tx, "act_");
      const resultId = await newId(tx, "res_");
      const argsHash = sha256Hex(canonicalJson(a.args));
      const resultDigest = sha256Hex(canonicalJson({ resultId, summary: a.summary }));
      const row = { seq, prevHash: prev, ts: a.ts, actorKind: a.actorKind, actorId: a.actorId, command: a.command, argsHash, proposalId: a.proposalId ?? null, resultDigest };
      const hash = sha256Hex(canonicalJson({ seq, prev_hash: prev, ts: a.ts, actor: `${a.actorKind}:${a.actorId}`, command: a.command, args_hash: argsHash, proposal_id: row.proposalId, result_digest: resultDigest }));
      await tx.insert(actions).values({
        ...row, actionId, hash, onBehalfOf: a.onBehalfOf ?? null, agentRunId: a.agentRunId ?? null, routineRunId: a.routineRunId ?? null, argsJson: JSON.stringify(a.args),
        resultId, summary: a.summary, reversible: a.reversible ?? "no", reverseJson: a.reverse ? JSON.stringify(a.reverse) : null,
        reversesSeq: a.reverses ? (byKey.get(a.reverses) ?? null) : null,
      });
      if (a.key) byKey.set(a.key, seq);
      if (a.proposalId) await tx.update(proposals).set({ executedActionSeq: seq }).where(eq(proposals.id, a.proposalId));
      prev = hash;
      out.push({ seq, hash, ts: a.ts, command: a.command, summary: a.summary });
    }
    this.bump("actions", out.length);
    // The approval audit chain, in decision order.
    const [ah] = (await tx.select({ seq: approvalAudit.seq, hash: approvalAudit.hash }).from(approvalAudit).orderBy(asc(approvalAudit.seq))).slice(-1);
    let aseq = ah?.seq ?? 0;
    let aprev = ah?.hash ?? GENESIS;
    for (const x of [...this.audits].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
      aseq += 1;
      const hash = sha256Hex(canonicalJson({ seq: aseq, prev_hash: aprev, ts: x.ts, proposal_id: x.proposalId, principal: x.principalId, attempt: x.attempt, outcome: x.outcome }));
      await tx.insert(approvalAudit).values({ ...x, seq: aseq, prevHash: aprev, hash });
      aprev = hash;
    }
    this.bump("approval_audit", this.audits.length);
    return out;
  }

  async chat(channel: string, author: string, text: string, ts: string): Promise<string> {
    const id = await newId(this.tx, "simc_");
    await this.tx.insert(simChatMessages).values({ id, channel, author, text, inbound: false, cardJson: null, ts });
    this.bump("sim_chat_messages");
    return id;
  }
}

/**
 * The history around the agent: the past payrolls Theo submitted and Weft paid, the New York rate notice Vic applied
 * in February, hand-offs to a tax specialist and the people ops channels. The agent's own runs are not planted here:
 * the showcase runs (./showcase.ts) are real recorded runs.
 */
async function seedHistory(L: Layer): Promise<void> {
  // Each processed Weft payroll: submitted by Theo on its approval-deadline day, then settled by the bank.
  const runs = await L.tx.select().from(payrollRuns).where(eq(payrollRuns.status, "processed")).orderBy(asc(payrollRuns.periodEnd));
  for (const run of runs) {
    // The run's stored totals (contracts TOTALS_FIELDS: { totalCost: { amount } }).
    const t = JSON.parse(run.totalsJson ?? "{}") as Record<string, { amount?: number } | undefined>;
    const bank = (t.netPay?.amount ?? 0) + (t.reimbursements?.amount ?? 0);
    const checks = await L.tx.select({ status: paychecks.status }).from(paychecks).where(eq(paychecks.payrollRunId, run.id));
    const included = checks.filter((c) => c.status !== "excluded").length;
    const at = run.approvedAt ?? new Date(Date.parse(run.approvalDeadline) - 6 * 3_600_000).toISOString();
    L.action({ ts: at, actorKind: "human", actorId: "usr_theo", command: "payroll.submit_run", args: { run_id: run.id }, summary: `Submitted ${run.id}: ${included} paychecks, ${money(bank)} to the bank`, reversible: "no" });
    L.action({ ts: run.processedAt ?? pt(run.payday, 6), actorKind: "system", actorId: "svc_events", command: "payroll.mark_processed", args: { run_id: run.id }, summary: `Processed ${run.id}: paychecks settled`, reversible: "no" });
  }
  // The NY DOL 2026 rate notice (the notice row is planted and already resolved): Vic applied the new rate on Feb 14,
  // as tax.update_rate records it, reversible through tax.revert_rate.
  {
    const [ny] = await L.tx.select().from(taxAccounts).where(eq(taxAccounts.agency, "ny_dol"));
    const [nyRate] = await L.tx.select().from(employerTaxRates).where(eq(employerTaxRates.source, "notice:ntc_0001"));
    const args = { tax_account_id: ny?.id ?? "txa_ny_dol", code: "sui", rate: nyRate?.rate ?? "0.041", effective_from: nyRate?.effectiveFrom ?? "2026-01-01", source_notice_id: "ntc_0001" };
    L.action({ ts: "2026-02-14T19:05:00.000Z", actorKind: "human", actorId: "usr_dana", command: "tax.update_rate", args, summary: `Updated NY SUI rate 3.80% to 4.10% effective 2026-01-01${nyRate ? ` (${nyRate.id})` : ""}`,
      reversible: nyRate ? "yes" : "no", reverse: nyRate ? { rate_id: nyRate.id } : undefined });
  }
  // Open hand-offs to a tax specialist, and one already resolved.
  const hand = [
    { kind: "tax_specialist", reason: "deposit_schedule_question", summary: "The IRS letter asks whether Larkspur moves to a semiweekly deposit schedule next year; a tax specialist should confirm the lookback period.", status: "open", createdAt: pt("2026-10-22", 10), subjectRef: "txa_0001" },
    { kind: "tax_specialist", reason: "multi_state_withholding", summary: "Noor Castellanos will work remotely from Colorado; confirm the CO withholding and FAMLI setup before her first payroll.", status: "acknowledged", createdAt: pt("2026-10-23", 14), subjectRef: "offr_0001", assignee: "usr_theo" },
    { kind: "hr_person", reason: "leave_question", summary: "Talia Brennan asked about paid family leave timing; Sam answered with the NY PFL guide.", status: "resolved", createdAt: pt("2026-09-08", 11), subjectRef: "wrk_0028", resolvedAt: pt("2026-09-09", 15), note: "Answered with the NY PFL guide." },
  ];
  for (const h of hand) {
    await L.tx.insert(handoffCases).values({ id: await newId(L.tx, "hnd_"), companyId: CO, kind: h.kind, reason: h.reason, subjectRef: h.subjectRef, workerId: null, summary: h.summary,
      evidenceJson: JSON.stringify([{ label: "Subject", ref: h.subjectRef }]), status: h.status, assigneePrincipalId: h.assignee ?? null, openedBy: AGENT, runId: null,
      createdAt: h.createdAt, resolvedAt: h.resolvedAt ?? null, resolutionNote: h.note ?? null });
    L.bump("handoff_cases");
  }
  // People ops chat spread over days.
  for (const [ch, author, text, at] of [
    ["#new-hires", "Weft agent", "Welcome Ana Sousa and Ben Ashdown, who start today in Oakland. Accounts are ready.", pt("2026-10-01", 9)],
    ["#new-hires", "Weft agent", "Welcome Mira Delgado, Robotics Engineer, starting today in Oakland.", pt("2026-10-19", 9)],
    ["#payroll", "Theo Marsh", "Sep 30 payroll approved. Thanks for the quick review.", pt("2026-09-28", 14)],
    ["#people-ops", "Sam Okafor", "Reminder: managers, please decide pending time-off requests before Friday.", pt("2026-10-14", 10)],
    ["#leadership", "Vic Akisole", "Colorado hiring plan is on track; registrations go in before Noor starts.", pt("2026-10-20", 16)],
  ] as const) await L.chat(ch, author, text, at);
  // The base world's channel posts carry the seed time; with a year of history around them they would read as the
  // newest posts, so here each one gets the day it talks about (Ana and Ben started Oct 1, the Oct 15 run settled
  // that day, open enrollment opened Oct 5). The channel lists in time order.
  const dated: Record<string, string> = {
    "Reminder: the Brooklyn Studio demo day is Thursday. Snacks on the third floor.": pt("2026-10-19", 10),
    "Austin Yard fleet hit 1,000 autonomous pallet moves this week.": pt("2026-10-23", 16),
    "Open enrollment questions can go in this channel.": pt("2026-10-05", 10, 30),
    "The Oct 15 payroll settled. Next approval deadline is Wed Oct 28 at 5 pm PT.": pt("2026-10-15", 14),
    "Welcome Ana and Ben to Larkspur!": pt("2026-10-01", 9, 30),
    "Hardware onboarding buddy list is pinned in the team folder.": pt("2026-10-01", 10),
  };
  for (const m of SEED_CHAT) {
    const ts = dated[m.text];
    if (ts) await L.tx.update(simChatMessages).set({ ts }).where(and(eq(simChatMessages.channel, m.channel), eq(simChatMessages.text, m.text)));
  }
}

/** Decided history in the Inbox and the suggestions waiting this week. Subjects are resolved by name from the seeded
 * workers and the time-off decision points at a request the history really holds, so a headline never names one
 * person while its arguments point at another. Previews come from the commands themselves where the subject allows. */
async function seedDecidedProposals(L: Layer, ws: W[]): Promise<void> {
  const byName = (first: string, last: string) => {
    const w = ws.find((x) => x.firstName === first && x.lastName === last);
    if (!w) throw new Error(`rich seed: no worker ${first} ${last}`);
    return w;
  };
  const tomasz = byName("Tomasz", "Nowak");
  const kofi = byName("Kofi", "Mensah");
  const caleb = byName("Caleb", "Whitaker");
  const rename = { worker_id: tomasz.id, preferred_name: "Tom" };
  const laptop = { worker_id: kofi.id };
  const laptopPreview = await L.preview("it.order_device", laptop);
  // Caleb's September vacation, decided the way the history decided it; the proposal is the one that decision approved.
  const [req] = (await L.tx.select().from(timeOffRequests).where(eq(timeOffRequests.workerId, caleb.id)).orderBy(asc(timeOffRequests.startAt)))
    .filter((q) => q.status === "taken" && q.policyId === "top_vac_us" && q.decidedAt);
  const decided: Parameters<Layer["proposal"]>[0][] = [
    { at: pt("2026-03-03", 9), command: "people.update_profile", args: rename, subjectRef: tomasz.id, risk: L.risk("people.update_profile", rename), headline: `Set the preferred name for ${name(tomasz)} to Tom`,
      diff: [{ label: "Preferred name", before: "none", after: "Tom" }], evidence: [{ label: "Worker", ref: tomasz.id }], domain: "people", status: "executed", decidedBy: "usr_sam", decidedAt: pt("2026-03-03", 11), reversible: true,
      exec: { ts: pt("2026-03-03", 11), actorKind: "human", actorId: "usr_sam", summary: `Set the preferred name of ${name(tomasz)} to Tom`, reversible: "yes", reverse: { command: "people.update_profile", args: { worker_id: tomasz.id, preferred_name: null } } } },
    { at: pt("2026-05-11", 10), command: "it.order_device", args: laptop, subjectRef: laptopPreview.subjectRef, risk: laptopPreview.risk, headline: laptopPreview.title, diff: laptopPreview.diff,
      moneyCents: laptopPreview.moneyCents ?? undefined, evidence: laptopPreview.evidence, domain: "it", status: "denied", decidedBy: "usr_dana", decidedAt: pt("2026-05-11", 14), decisionCode: "not_needed",
      decisionNote: "Repair first; the screen is under warranty." },
    { at: pt("2026-07-30", 9), command: "comms.send_message", args: { channel: "#general", text: "Summer hours start Monday." }, subjectRef: "#general", risk: "R1", headline: "Post the summer hours note in #general", kind: "suggestion", domain: "comms", status: "dismissed", decidedBy: "usr_dana", decidedAt: pt("2026-07-30", 12) },
    { at: pt("2026-10-05", 9), command: "benefits.nudge_open_enrollment", args: { plan_year: 2027 }, subjectRef: "open_enrollment:2027", risk: "R1", headline: "Remind the employees who have not opened the 2027 enrollment", kind: "suggestion", domain: "benefits", status: "dismissed", decidedBy: "usr_sam", decidedAt: pt("2026-10-05", 10), decisionNote: "Waiting until the carrier rates are final." },
  ];
  const decidedIds: string[] = [];
  for (const d of decided) decidedIds.push(await L.proposal(d));
  if (req) {
    const year = Number(req.startAt.slice(0, 4));
    const span = req.startAt === req.endAt ? payroll.shortDay(req.startAt, year) : `${payroll.shortDay(req.startAt, year)} to ${payroll.shortDay(req.endAt, year)}`;
    const args = { request_id: req.id, decision: "approve" };
    const id = await L.proposal({ at: req.createdAt, command: "time_off.decide", args, subjectRef: req.id, risk: "R1", headline: `Approve ${name(caleb)}'s vacation ${span} (${req.requestedMinutes / 60} h)`,
      diff: [{ label: "Status", before: "pending", after: "approved" }], evidence: [{ label: "Request", ref: req.id }], domain: "people", status: "executed", decidedBy: req.decidedBy ?? "usr_dana",
      decidedAt: req.decidedAt!, onBehalfOf: req.decidedBy ?? "usr_dana" });
    // The history already logged this decision; it becomes the action the proposal executed.
    const act = L.pending.find((a) => a.command === "time_off.decide" && a.args.request_id === req.id);
    if (act) { act.proposalId = id; act.key = id; }
  }
  // The rolled-back profile edit: the reversing row points at the edit above (its action key is the proposal id).
  L.action({ ts: pt("2026-03-03", 15), actorKind: "human", actorId: "usr_sam", command: "people.update_profile", args: { worker_id: tomasz.id, preferred_name: null }, summary: `Rolled back the preferred name edit on ${name(tomasz)}: he asked to keep his full name`, reversible: "no", reverses: decidedIds[0] });
  // Pending suggestions in the Inbox for this week. Colorado's registrations are not among them: accepting Noor's offer
  // files them through the new-hire routine, per tax account, and a planted one would sit beside those as a duplicate.
  const sug: Parameters<Layer["proposal"]>[0][] = [
    { at: pt("2026-10-26", 8, 5), command: "routines.enable", args: { routine_id: "rt_expense_review" }, subjectRef: "rt_expense_review", risk: "R1", headline: "Turn on the Expense review routine: 8 claims are waiting for a decision", kind: "suggestion", domain: "company", status: "pending", expiresAt: "2026-11-09T16:00:00.000Z",
      agentNote: "The routine checks each claim against the policy and drafts the decision for a person to approve." },
    { at: pt("2026-10-26", 8, 6), command: "benefits.nudge_open_enrollment", args: { plan_year: 2027 }, subjectRef: "open_enrollment:2027", risk: "R1", headline: "Nudge the open enrollment stragglers before the window closes", kind: "suggestion", domain: "benefits", status: "pending", expiresAt: "2026-11-09T16:00:00.000Z" },
  ];
  for (const x of sug) await L.proposal(x);
}

/** The slot a routine's own cron fires at on `day`, or on the latest day before it the cron fires (the PREBUILT
 * trigger, read as minute, hour, day of month and weekday in PT), so a recorded cron run never sits at an hour or on a
 * day its schedule could not produce (the showcase recorder fires its cron runs here). An hourly cron takes `hour`. */
export function cronSlot(routineId: string, day: string, hour = 9): string {
  const r = PREBUILT.find((x) => x.id === routineId);
  if (!r || r.trigger.type !== "cron") throw new Error(`rich seed: ${routineId} has no cron trigger`);
  const [mi, h, dom, , dow] = r.trigger.cron.split(" ") as [string, string, string, string, string];
  const inDow = (d: string) => dow === "*" || dow.split(",").some((part) => {
    const [lo, hi] = part.split("-").map(Number) as [number, number | undefined];
    return hi === undefined ? weekday(d) === lo : weekday(d) >= lo && weekday(d) <= hi;
  });
  let d = day;
  for (let i = 0; i < 40 && !((dom === "*" || Number(dom) === Number(d.slice(8))) && inDow(d)); i++) d = addDays(d, -1);
  return pt(d, h === "*" ? hour : Number(h), Number(mi));
}

/** A marriage reported in September whose 30-day window closed with no changes (Kofi Mensah): the life-event record
 * and its closed window, so the Benefits page and the life-event routine have history to read. */
async function seedLifeEventHistory(L: Layer): Promise<void> {
  const all = await L.tx.select().from(workers).orderBy(asc(workers.id));
  const kofi = all.find((w) => w.firstName === "Kofi" && w.lastName === "Mensah");
  if (!kofi) return;
  const eventId = await newId(L.tx, "lev_");
  const windowId = await newId(L.tx, "ewn_");
  await L.tx.insert(enrollmentWindows).values({ id: windowId, companyId: CO, workerId: kofi.id, kind: "life_event", lifeEventId: eventId, opensOn: "2026-09-14", closesOn: "2026-10-14", status: "closed", remindersSent: 3, createdAt: pt("2026-09-14", 9) });
  await L.tx.insert(lifeEvents).values({ id: eventId, workerId: kofi.id, kind: "marriage", eventDate: "2026-09-12", note: "", status: "closed_no_change", reportedBy: "usr_sam", reportedAt: pt("2026-09-14", 9), windowId });
  L.bump("life_events"); L.bump("enrollment_windows");
}

/** Employee numbers for the layer's own employees, from the counter offers.accept and the portal use (numbered workers
 * plus one), in start-date order, onboarding hires included: the next live accept continues the sequence. */
async function numberRichEmployees(L: Layer): Promise<void> {
  const all = await L.tx.select().from(workers).orderBy(asc(workers.id));
  let n = all.filter((w) => w.id <= "wrk_0051" && w.employeeNumber !== null).length;
  const mine = all.filter((w) => w.id > "wrk_0051" && w.type === "employee").sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.id < b.id ? -1 : 1));
  for (const w of mine) {
    n += 1;
    await L.tx.update(workers).set({ employeeNumber: `EMP-${String(n).padStart(4, "0")}` }).where(eq(workers.id, w.id));
  }
}

// ---- time off history -----------------------------------------------------------------------------------------

async function seedTimeOffHistory(L: Layer, ws: W[]): Promise<void> {
  const rnd = prng(20261026);
  const asg = await L.tx.select().from(timeOffAssignments);
  const byWorker = new Map<string, typeof asg>();
  for (const a of asg) byWorker.set(a.workerId, [...(byWorker.get(a.workerId) ?? []), a]);
  const reasons = ["Family trip", "Long weekend", "Moving apartments", "Wedding in the family", "Rest day", "Visiting friends", "School event"];
  for (const w of ws) {
    if (w.type !== "employee" || w.status !== "active") continue;
    const mine = byWorker.get(w.id) ?? [];
    const vac = mine.find((a) => a.policyId === "top_vac_us");
    const sick = mine.find((a) => a.policyId.startsWith("top_sick_"));
    const usedBy = new Map<string, number>();
    const firstUse = new Map<string, string>();
    const firstDay = w.startDate > "2026-01-05" ? addDays(w.startDate, 30) : "2026-01-05";
    const lastDay = "2026-10-09";
    if (firstDay > lastDay) continue;
    const n = 2 + Math.floor(rnd() * 3);
    const taken = new Set<string>();
    for (let i = 0; i < n; i++) {
      const isSick = i === n - 1 && !!sick && rnd() < 0.6;
      const a = isSick ? sick! : vac;
      if (!a) continue;
      if (isSick && a.policyId === "top_sick_ca" && addDays(w.startDate, 90) > lastDay) continue;
      const span = Date.parse(`${lastDay}T12:00:00Z`) - Date.parse(`${firstDay}T12:00:00Z`);
      let start = new Date(Date.parse(`${firstDay}T12:00:00Z`) + Math.floor(rnd() * span)).toISOString().slice(0, 10);
      while (!isWeekday(start) || HOLIDAYS.has(start)) start = addDays(start, 1);
      const len = isSick ? 1 : 1 + Math.floor(rnd() * 3);
      const days: { date: string; minutes: number; holiday: boolean }[] = [];
      let d = start;
      while (days.length < len) { if (isWeekday(d) && !HOLIDAYS.has(d)) days.push({ date: d, minutes: 480, holiday: false }); d = addDays(d, 1); }
      if (days.some((x) => taken.has(x.date)) || days.at(-1)!.date > "2026-10-14") continue;
      days.forEach((x) => taken.add(x.date));
      const minutes = days.length * 480;
      const roll = rnd();
      const status = roll < 0.08 ? "denied" : roll < 0.14 ? "cancelled" : "taken";
      const approver = w.managerId === "wrk_0004" ? "usr_imani" : "usr_dana";
      const why = approver === "usr_imani" ? "Manager Imani Ferreira decides" : "Vic Akisole decides for managers without a Weft login";
      const createdAt = pt(addDays(start, -14 - Math.floor(rnd() * 10)), 10);
      const id = await newId(L.tx, "tor_");
      await L.tx.insert(timeOffRequests).values({
        id, companyId: CO, workerId: w.id, policyId: a.policyId, status, startAt: start, endAt: days.at(-1)!.date, rangeType: "date", timeZone: w.timezone,
        requestedMinutes: minutes, daysJson: JSON.stringify(days), reason: isSick ? "Sick day" : reasons[Math.floor(rnd() * reasons.length)]!, approverPrincipalId: approver,
        routingJson: JSON.stringify([{ principalId: approver, why }]), checksJson: "[]", decidedBy: approver, decidedAt: pt(addDays(createdAt.slice(0, 10), 1), 11),
        decisionNote: status === "denied" ? "Coverage is thin that week; please pick other dates." : "", createdAt,
      });
      L.bump("time_off_requests");
      if (status !== "cancelled") L.action({ ts: pt(addDays(createdAt.slice(0, 10), 1), 11), actorKind: "human", actorId: approver, command: "time_off.decide", args: { request_id: id, decision: status === "denied" ? "deny" : "approve" },
        summary: `${status === "denied" ? "Denied" : "Approved"} ${days.length * 8} h of ${isSick ? "sick leave" : "vacation"} for ${name(w)} (${id})`, reversible: "no" });
      if (status === "taken") {
        // One use row per day, as time_off.decide writes them.
        for (const x of days) {
          await L.tx.insert(timeOffLedger).values({ id: await newId(L.tx, "tol_"), assignmentId: a.id, workerId: w.id, policyId: a.policyId, kind: "use", minutes: -x.minutes,
            effectiveDate: x.date, sourceRef: id, note: "time off taken", createdAt: pt(x.date, 18) });
          L.bump("time_off_ledger");
        }
        usedBy.set(a.id, (usedBy.get(a.id) ?? 0) + minutes);
        firstUse.set(a.id, firstUse.has(a.id) && firstUse.get(a.id)! < start ? firstUse.get(a.id)! : start);
      }
    }
    // The imported opening balance is net of usage; itemizing the usage adds the same minutes back as accrued, so
    // Available stays exactly what the base seed imported and caps still hold. It is dated on the first itemized use,
    // so an as-of balance from January on never dips below what the person really had.
    for (const [assignmentId, minutes] of usedBy) {
      const a = mine.find((x) => x.id === assignmentId)!;
      const on = firstUse.get(assignmentId)!;
      await L.tx.insert(timeOffLedger).values({ id: await newId(L.tx, "tol_"), assignmentId, workerId: w.id, policyId: a.policyId, kind: "import", minutes,
        effectiveDate: on, note: "accrued before the usage itemized above, imported from the previous provider", createdAt: pt(on, 6) });
      L.bump("time_off_ledger");
    }
  }
  // Out today (Mon Oct 26): an approved CA sick day and a NY vacation day, outside the hardware team. Approved the way
  // time_off.decide approves: a use row for the day and the decision on the action log. The day sits inside the
  // Oct 16 to 31 draft, whose planted paychecks carry no leave line; a recompute (the tour's rate change runs one)
  // adds it, which is the engine's own behavior for approved leave in an open period.
  for (const [wid, policy, reason] of [["wrk_0014", "top_sick_ca", "Sick day"], ["wrk_0028", "top_vac_us", "Long weekend"]] as const) {
    const w = ws.find((x) => x.id === wid);
    if (!w) continue;
    const reqId = await newId(L.tx, "tor_");
    const a = (byWorker.get(wid) ?? []).find((x) => x.policyId === policy);
    if (a) {
      await L.tx.insert(timeOffLedger).values({ id: await newId(L.tx, "tol_"), assignmentId: a.id, workerId: wid, policyId: policy, kind: "use", minutes: -480,
        effectiveDate: "2026-10-26", sourceRef: reqId, note: null, createdAt: pt("2026-10-23", 11) });
      L.bump("time_off_ledger");
    }
    L.action({ ts: pt("2026-10-23", 11), actorKind: "human", actorId: "usr_dana", command: "time_off.decide", args: { request_id: reqId, decision: "approve" },
      summary: `Approved 8 h of ${policy === "top_sick_ca" ? "sick leave" : "vacation"} for ${name(w)} (${reqId})`, reversible: "no" });
    await L.tx.insert(timeOffRequests).values({ id: reqId, companyId: CO, workerId: wid, policyId: policy, status: "approved", startAt: "2026-10-26", endAt: "2026-10-26",
      rangeType: "date", timeZone: w.timezone, requestedMinutes: 480, daysJson: JSON.stringify([{ date: "2026-10-26", minutes: 480, holiday: false }]), reason,
      approverPrincipalId: "usr_dana", routingJson: JSON.stringify([{ principalId: "usr_dana", why: "Vic Akisole decides for managers without a Weft login" }]),
      checksJson: "[]", decidedBy: "usr_dana", decidedAt: pt("2026-10-23", 11), decisionNote: "", createdAt: pt("2026-10-22", 9) });
    L.bump("time_off_requests");
  }
}

// ---- onboarding, documents and offboarding ----------------------------------------------------------------------


async function seedPeopleRecords(L: Layer, ws: W[]): Promise<void> {
  const { tx } = L;
  const kinds = ["sign_offer", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection", "it_accounts"] as const;
  const owner = (k: string) => (k === "i9_sim" ? "hr" : k === "it_accounts" ? "agent" : "employee");
  for (const w of ws.filter((x) => x.type === "contractor")) {
    for (const k of ["sign_offer", "direct_deposit", "it_accounts"] as const) {
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId: w.id, kind: k, status: "done", owner: k === "it_accounts" ? "agent" : "employee", dueOn: w.startDate, doneAt: pt(addDays(w.startDate, -3), 11) });
      L.bump("onboarding_tasks");
    }
  }
  for (const w of ws) {
    if (w.type !== "employee") continue;
    const mira = w.id === "wrk_0022";
    for (const k of kinds) {
      const done = !mira || ["sign_offer", "federal_w4", "state_withholding", "it_accounts"].includes(k);
      const blocked = mira && k === "direct_deposit";
      await tx.insert(onboardingTasks).values({ id: await newId(tx, "obt_"), workerId: w.id, kind: k, status: blocked ? "blocked" : done ? "done" : "pending", owner: owner(k),
        dueOn: w.startDate, doneAt: done ? pt(addDays(w.startDate, -5), 11) : null, blockedReason: blocked ? "No bank account on file; paychecks are blocked until direct deposit is set up" : null });
      L.bump("onboarding_tasks");
    }
  }
  const stateForm: Record<string, string> = { CA: "DE 4: California employee withholding allowance certificate", NY: "IT-2104: New York employee withholding certificate" };
  for (const w of ws) {
    if (w.type !== "employee") continue;
    const signed = pt(addDays(w.startDate, -7), 10);
    const docs: [string, string][] = [
      ["offer_letter", `Offer letter: ${w.title}`], ["confidentiality_agreement", "Confidentiality and invention assignment agreement"],
      ["w4", "Form W-4, employee's withholding certificate"], ["i9", "Form I-9 receipt (masked)"],
    ];
    if (w.workState && stateForm[w.workState]) docs.push(["state_withholding", stateForm[w.workState]!]);
    for (const [kind, title] of docs) {
      const body = `${title}\nLarkspur Robotics\n${name(w)}\nSigned ${payroll.shortDay(signed.slice(0, 10), 0)}.`;
      await tx.insert(documents).values({ id: await newId(tx, "doc_"), companyId: CO, workerId: w.id, offerId: null, kind, title, status: "signed", bodyText: body, sha256: sha256Hex(body),
        createdAt: signed, sentAt: signed, signedAt: signed });
      L.bump("documents");
    }
  }
  // A summer departure with a completed case (the departure the reports count is a real record).
  const leaverId = await newId(tx, "wrk_");
  const lastDay = "2026-07-17";
  await tx.insert(workers).values({ id: leaverId, companyId: CO, employeeNumber: "EMP-0099", type: "employee", workerType: "us_w2", status: "inactive", firstName: "Rafael", lastName: "Ostrander",
    workEmail: "rafael.ostrander@larkspur.example", title: "Field Service Technician", departmentId: "dpt_operations", managerId: null, workplaceId: "wkp_oakland", workState: "CA",
    timezone: "America/Los_Angeles", startDate: "2024-02-12", endDate: lastDay, payScheduleId: "ps_us_semimonthly", createdAt: "2024-02-01T17:00:00.000Z", updatedAt: pt(lastDay, 17) });
  await tx.insert(payRates).values({ id: await newId(tx, "prt_"), workerId: leaverId, kind: "salary", amountCents: 7_800_000, effectiveFrom: "2024-02-12", effectiveTo: lastDay });
  await tx.insert(taxProfiles).values({ workerId: leaverId, w4Version: "2020", filingStatus: "mfj", source: "seed" });
  L.bump("workers");
  // Married, on the PPO, dental and vision for employee and spouse and saving 4% in the 401(k), until the end of July.
  L.bump("benefit_enrollments", await enrollLeaver(tx, leaverId, "2024-02-12", "ee_spouse", ["ppo", "dental", "vision", "k401"]));
  const done = await newId(tx, "ofb_");
  await tx.insert(offboardingCases).values({ id: done, companyId: CO, workerId: leaverId, kind: "voluntary", lastDay, reasonNote: "Relocating to be closer to family", status: "complete", createdAt: pt("2026-07-01", 10), closedAt: pt("2026-07-31", 12) });
  const stepsDone: [string, string][] = [
    ["final_pay", "Final pay included on the Jul 31 regular run, with accrued vacation paid out"], ["directory_suspend", "Suspended Workspace rafael.ostrander"],
    ["sso_deactivate", "Suspended SSO rafael.ostrander"], ["group_removal", "Removed 3 group memberships"], ["app_removal", "Removed Chat rafael.ostrander"],
    ["device_lock", "Locked 1 device; returned to the Oakland office on Jul 20"], ["cobra_notice", "COBRA notice emailed to rafael.ostrander@mail.example"], ["benefits_terminate", "Terminated 4 enrollments, effective through Jul 31"],
  ];
  for (const [kind, detail] of stepsDone) {
    await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: done, kind, status: "done", detail, doneAt: pt(kind === "final_pay" ? "2026-07-31" : "2026-07-18", 10) });
  }
  L.action({ ts: pt("2026-07-01", 10), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: leaverId, last_day: lastDay }, summary: `Started offboarding for Rafael Ostrander (${leaverId}), last day ${lastDay}`, reversible: "no" });
  // An open resignation, about half done.
  const jonah = ws.find((w) => w.id === "wrk_0016");
  if (jonah) {
    const open = await newId(tx, "ofb_");
    await tx.insert(offboardingCases).values({ id: open, companyId: CO, workerId: jonah.id, kind: "voluntary", lastDay: "2026-11-13", reasonNote: "Resigned to start a graduate program", status: "open", createdAt: pt("2026-10-16", 15) });
    const plan: [string, string, string][] = [
      ["final_pay", "pending", "Final pay on the Nov 13 regular run"], ["directory_suspend", "pending", "Scheduled for the end of the last day"], ["sso_deactivate", "pending", ""],
      ["group_removal", "done", "Removed from the release on-call group"], ["app_removal", "done", "Handed off test tooling ownership to Kofi Mensah"], ["device_lock", "pending", ""],
      ["cobra_notice", "done", "COBRA notice prepared and sent ahead of the last day"], ["benefits_terminate", "pending", "Coverage ends Nov 30"],
    ];
    for (const [kind, status, detail] of plan) await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: open, kind, status, detail, doneAt: status === "done" ? pt("2026-10-20", 11) : null });
    // What offboarding.start does to the person: they are offboarding from the day the case opens, with the last day as
    // their end date, so every screen and the agent's people reads agree with the open case.
    await tx.update(workers).set({ status: "offboarding", endDate: "2026-11-13", updatedAt: pt("2026-10-16", 15) }).where(eq(workers.id, jonah.id));
    L.action({ ts: pt("2026-10-16", 15), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: jonah.id, last_day: "2026-11-13" }, summary: `Started offboarding for ${name(jonah)} (${jonah.id}), last day 2026-11-13`, reversible: "no" });
  }
  // Owen Mercer: the base world gives him a last day of Oct 23 (the carrier reconciliation reads it) and pays him
  // through it on the Oct 30 draft, but never offboards him. Here he resigned on Oct 9 and the case ran as
  // offboarding.start and its steps run it: he is offboarding, access and benefits ended with his last day, and the
  // one step left is final pay, which rides the Oct 30 run. Every screen then agrees he no longer works here.
  const owen = ws.find((w) => w.firstName === "Owen" && w.lastName === "Mercer");
  if (owen?.endDate) {
    const login = `${owen.firstName.toLowerCase()}.${owen.lastName.toLowerCase()}`;
    const caseId = await newId(tx, "ofb_");
    const last = owen.endDate;
    const closeOut = pt(last, 17, 30);
    await tx.insert(offboardingCases).values({ id: caseId, companyId: CO, workerId: owen.id, kind: "voluntary", lastDay: last, reasonNote: "Resigned to join a customer's team", status: "open", createdAt: pt("2026-10-09", 15) });
    const enrolled = (await tx.select().from(benefitEnrollments).where(eq(benefitEnrollments.workerId, owen.id))).filter((e) => e.status === "active");
    const through = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
    const steps: [string, string, string][] = [
      ["final_pay", "pending", `Final pay on the ${payroll.shortDay("2026-10-30", 2026)} regular run, through the last day, with unused PTO`],
      ["directory_suspend", "done", `Suspended Workspace ${login}`], ["sso_deactivate", "done", `Suspended SSO ${login}`],
      ["group_removal", "done", "Removed group memberships"], ["app_removal", "done", `Removed Chat ${login}`],
      ["device_lock", "done", "Locked 1 device; a return label went to his home address"], ["cobra_notice", "done", `COBRA notice emailed to ${owen.personalEmail ?? `${login}@mail.example`}`],
      ["benefits_terminate", "done", `Terminated ${enrolled.length} ${enrolled.length === 1 ? "enrollment" : "enrollments"}, effective through ${payroll.shortDay(through, 2026)}`],
    ];
    for (const [kind, status, detail] of steps) await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId, kind, status, detail, doneAt: status === "done" ? closeOut : null });
    await tx.update(workers).set({ status: "offboarding", updatedAt: closeOut }).where(eq(workers.id, owen.id));
    await tx.update(itAccounts).set({ status: "suspended" }).where(eq(itAccounts.workerId, owen.id));
    for (const e of enrolled) await tx.update(benefitEnrollments).set({ status: "terminated", effectiveTo: e.effectiveTo !== null && e.effectiveTo < through ? e.effectiveTo : through }).where(eq(benefitEnrollments.id, e.id));
    L.action({ ts: pt("2026-10-09", 15), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: owen.id, last_day: last }, summary: `Started offboarding for ${name(owen)} (${owen.id}), last day ${last}`, reversible: "no" });
    for (const [kind, status, detail] of steps) {
      if (status !== "done") continue;
      L.action({ ts: closeOut, actorKind: "human", actorId: "usr_sam", command: offboarding.STEP_COMMAND[kind as keyof typeof offboarding.STEP_COMMAND],
        args: { case_id: caseId, step: kind }, summary: `${detail} for ${name(owen)}`, reversible: "no" });
    }
  }
  L.bump("offboarding_cases", 3);
  // Hires as actions.
  for (const w of ws.filter((x) => x.type === "employee" && x.startDate >= "2026-01-01")) {
    L.action({ ts: pt(addDays(w.startDate, -21), 10), actorKind: "human", actorId: "usr_sam", command: "people.create_worker", args: { worker_id: w.id }, summary: `Added ${name(w)} (${w.id}) as ${w.title}, starting ${w.startDate}`, reversible: "no" });
  }
}

// ---- contractor payouts and compliance history -------------------------------------------------------------------

function lastWeekday(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  let d = new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}
function plusBusinessDays(d: string, n: number): string { let x = d; let k = 0; while (k < n) { x = addDays(x, 1); if (isWeekday(x)) k++; } return x; }

async function seedMoneyAndCompliance(L: Layer, ws: W[]): Promise<void> {
  const { tx } = L;
  const fx: Record<string, string> = { EUR: "1.08", INR: "0.012", CAD: "0.73" };
  const rates = await tx.select().from(payRates);
  for (const w of ws.filter((x) => x.type === "contractor")) {
    const rate = rates.find((r) => r.workerId === w.id && r.kind === "contract_monthly");
    if (!rate) continue;
    // From the first month Weft holds pay history for (January, the imported runs), so no month shows contractors alone.
    let month = w.startDate.slice(0, 7) < "2026-01" ? "2026-01" : w.startDate.slice(0, 7);
    while (month <= "2026-09") {
      const day = lastWeekday(month);
      const usd = Math.round(Number(rate.amountCents) * Number(fx[w.currency] ?? "1"));
      const failed = w.id === "wrk_0050" && month === "2026-03";
      for (const attempt of failed ? ["failed", "retry"] : ["paid"]) {
        const id = await newId(tx, "cpy_");
        const rail = await newId(tx, "simr_");
        const sentDay = attempt === "retry" ? plusBusinessDays(day, 2) : day;
        const delivered = plusBusinessDays(sentDay, 2);
        const ok = attempt !== "failed";
        await tx.insert(contractorPayments).values({ id, workerId: w.id, amountMinor: rate.amountCents, currency: w.currency, fxRate: fx[w.currency] ?? "1", usdCents: usd, status: ok ? "paid" : "failed",
          scheduledFor: sentDay, railStatus: ok ? "delivered" : "returned", railRef: rail, sentAt: pt(sentDay, 6), deliveredAt: ok ? pt(delivered, 10) : null });
        await tx.insert(simRailTransfers).values({ id: rail, paymentId: id, amountMinor: rate.amountCents, currency: w.currency, status: ok ? "delivered" : "returned", sentAt: pt(sentDay, 6), deliverAt: pt(delivered, 7), deliveredAt: ok ? pt(delivered, 10) : null });
        L.bump("contractor_payments");
      }
      const [y, m] = month.split("-").map(Number) as [number, number];
      month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
  }
  // Filed returns with confirmations.
  const acct = new Map((await tx.select().from(taxAccounts)).map((a) => [`${a.agency}:${a.accountType}`, a.id]));
  const filed: [string, string, string, string][] = [
    ["irs:federal", "941", "2026-Q1", "2026-04-28"], ["irs:federal", "941", "2026-Q2", "2026-07-29"], ["irs:federal", "940", "2025", "2026-01-27"], ["irs:federal", "w2_w3", "2025", "2026-01-27"],
    ["ca_edd:combined", "ca_de9", "2026-Q1", "2026-04-29"], ["ca_edd:combined", "ca_de9c", "2026-Q1", "2026-04-29"], ["ca_edd:combined", "ca_de9", "2026-Q2", "2026-07-30"], ["ca_edd:combined", "ca_de9c", "2026-Q2", "2026-07-30"],
    ["ny_dtf:withholding", "ny_nys45", "2026-Q1", "2026-04-29"], ["ny_dtf:withholding", "ny_nys45", "2026-Q2", "2026-07-30"], ["tx_twc:unemployment", "tx_c3", "2026-Q1", "2026-04-28"], ["tx_twc:unemployment", "tx_c3", "2026-Q2", "2026-07-29"],
  ];
  let k = 0;
  for (const [a, form, period, day] of filed) {
    const taxAccountId = acct.get(a);
    if (!taxAccountId) continue;
    k += 1;
    const confirmation = `SIM-${form.replace(/^(ca|ny|tx)_/, "").toUpperCase()}-${period.replace("-", "")}-${String(4100 + k)}`;
    await tx.insert(filings).values({ id: await newId(tx, "fil_"), taxAccountId, form, period, status: "accepted", filedAt: pt(day, 11), confirmation, dueOn: null });
    // The return as the agency simulator received it, with the confirmation it gave back.
    await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: a.split(":")[0]!, direction: "out", kind: "return_filing", body: canonicalJson({ form, period, note: "Filed from Weft" }),
      relatedNoticeId: null, confirmation, credentialName: null, ts: pt(day, 11) });
    L.bump("sim_agency_mail");
    L.action({ ts: pt(day, 11), actorKind: "human", actorId: "usr_theo", command: "tax.file_return", args: { form, period }, summary: `Filed ${form.replace(/^(ca|ny|tx)_/, "").toUpperCase()} for ${period} with ${a.split(":")[0]}; accepted`, reversible: "no" });
    L.bump("filings");
  }
  // More agency notices across states and statuses, with their mail.
  const ntc: { agency: string; kind: string; form: string; title: string; at: string; status: string; body: string; resolution?: string; confirmation?: string }[] = [
    { agency: "tx_twc", kind: "rate_change", form: "C-1", title: "TWC 2026 tax rate notice", at: "2026-01-12T16:00:00.000Z", status: "resolved", body: "The 2026 Texas unemployment tax rate for Larkspur Robotics is unchanged.", resolution: "Rate confirmed unchanged; no update needed." },
    { agency: "irs", kind: "deposit_schedule_change", form: "CP 136", title: "IRS deposit schedule notice", at: "2025-11-17T16:00:00.000Z", status: "resolved", body: "Based on the lookback period your deposit schedule for 2026 is monthly.", resolution: "Deposit schedule confirmed as monthly; acknowledgement sent.", confirmation: "SIM-IRS-ACK-20251119" },
    { agency: "ca_edd", kind: "benefit_charge", form: "DE 428T", title: "EDD statement of benefit charges", at: "2026-09-21T16:00:00.000Z", status: "in_review", body: "A former employee's claim was charged to the reserve account. Review the charge within 60 days." },
  ];
  for (const n of ntc) {
    const id = await newId(tx, "ntc_");
    const acc = [...acct.entries()].find(([key]) => key.startsWith(`${n.agency}:`))?.[1] ?? null;
    await tx.insert(notices).values({ id, companyId: CO, agency: n.agency, kind: n.kind, formCode: n.form, title: n.title, receivedAt: n.at, respondBy: n.status === "in_review" ? "2026-11-20" : null,
      status: n.status, taxAccountId: acc, fileName: `${n.agency.toUpperCase()}_${n.form.replace(/\W/g, "")}.txt`, bodyText: n.body, extractedJson: null, draftsJson: "[]",
      resolutionJson: n.resolution ? JSON.stringify({ note: n.resolution }) : null, responseConfirmation: n.confirmation ?? null, source: "simulated" });
    await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: n.agency, direction: "in", kind: "notice", body: n.body, relatedNoticeId: id, confirmation: null, credentialName: null, ts: n.at });
    if (n.confirmation) await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: n.agency, direction: "out", kind: "notice_response", body: "Acknowledged.", relatedNoticeId: id, confirmation: n.confirmation, credentialName: null, ts: new Date(Date.parse(n.at) + 2 * 86_400_000).toISOString() });
    L.bump("notices");
  }
  // The 2023 registrations as completed simulator records (Colorado stays for the tour).
  for (const [agency, type, at, num] of [["irs", "federal", "2023-02-20", "SIM-EIN"], ["ca_edd", "combined", "2023-03-06", "SIM-CA"], ["ny_dtf", "withholding", "2023-05-08", "SIM-NYW"], ["ny_dol", "unemployment", "2023-05-08", "SIM-NYU"], ["tx_twc", "unemployment", "2023-09-11", "SIM-TX"]] as const) {
    await tx.insert(simRegistrations).values({ id: await newId(tx, "sima_"), agency, companyId: CO, accountType: type, requestJson: JSON.stringify({ legal_name: "Larkspur Robotics" }), status: "complete", completeAt: pt(at, 10), accountNumber: `${num}-****`, fault: null });
    L.bump("sim_registrations");
  }
}

// ---- memory -------------------------------------------------------------------------------------------------------

const MEMORY_DOCS: { path: string; day: string; id: string; type: string; links: string[]; body: string; message: string }[] = [
  { path: "workstreams/q4-open-enrollment.md", day: "2026-10-05", id: "ws-q4-open-enrollment", type: "workstream", links: ["entities/people/wrk_0025"], message: "workstream: Q4 open enrollment",
    body: "# Q4 open enrollment\n\nOwner [[entities/people/wrk_0025|Sam Okafor]]. The 2027 window is open; stragglers get a nudge once the carrier rates are final.\n" },
  { path: "workstreams/co-expansion.md", day: "2026-10-20", id: "ws-co-expansion", type: "workstream", links: ["entities/people/wrk_0004", "entities/people/wrk_0001"], message: "workstream: Colorado expansion",
    body: "# Colorado expansion\n\nFirst Colorado hire starts Nov 2 under [[entities/people/wrk_0004|Imani Ferreira]]. Withholding and unemployment registrations are still to do. Sponsor [[entities/people/wrk_0001|Vic Akisole]].\n" },
  // The guided tour opens the SUI rate notice procedure; this thread links it, so its Backlinks are not empty.
  { path: "workstreams/2026-agency-notices.md", day: "2026-09-25", id: "ws-2026-agency-notices", type: "workstream", links: ["knowledge/procedures/state-sui-rate-notice.md", "entities/agencies/ca_edd-combined.md"], message: "workstream: 2026 agency notices",
    body: "# 2026 agency notices\n\nIn February, New York's unemployment rate notice went through [[knowledge/procedures/state-sui-rate-notice|the state SUI rate notice procedure]]: the rate change waited for Vic's approval. The Texas rate notice confirmed an unchanged rate. The [[entities/agencies/ca_edd-combined|EDD]] statement of benefit charges is still in review.\n" },
  { path: "workstreams/october-payroll.md", day: "2026-10-23", id: "ws-october-payroll", type: "workstream", links: ["entities/people/wrk_0002", "knowledge/preferences/agent/autonomy.md", "knowledge/facts/payroll-tax-calendar.md"], message: "workstream: October payroll",
    body: "# October payroll\n\nOct 15 settled. The Oct 30 draft has four flagged paychecks; [[entities/people/wrk_0002|Theo Marsh]] approves by the Wednesday deadline. The agent proposes the submit and waits, as [[knowledge/preferences/agent/autonomy|the autonomy preference]] asks. The Q3 returns and the October federal deposit follow on [[knowledge/facts/payroll-tax-calendar|the payroll tax calendar]].\n" },
  { path: "workstreams/october-expenses.md", day: "2026-10-23", id: "ws-october-expenses", type: "workstream", links: ["knowledge/facts/expense-policy.md", "entities/people/wrk_0001"], message: "workstream: October expenses",
    body: "# October expenses\n\nEight claims wait for a decision. Each one is checked against [[knowledge/facts/expense-policy|the expense policy]] when it is submitted; the Expense review routine, which drafts a decision per claim, stays off until [[entities/people/wrk_0001|Vic Akisole]] turns it on.\n" },
  { path: "timeline/monthly/2026-08.md", day: "2026-09-01", id: "timeline-2026-08", type: "timeline_monthly", links: [], message: "digest: monthly 2026-08", body: "# August 2026\n\n- Two semi-monthly payrolls ran on the previous provider.\n" },
  { path: "timeline/monthly/2026-09.md", day: "2026-10-01", id: "timeline-2026-09", type: "timeline_monthly", links: ["workstreams/october-payroll.md"], message: "digest: monthly 2026-09", body: "# September 2026\n\n- First two payrolls run in Weft (Sep 15 and Sep 30), approved by Theo.\n- Q3 deposits made on schedule.\n" },
  { path: "timeline/weekly/2026-W42.md", day: "2026-10-19", id: "timeline-2026-W42", type: "timeline_weekly", links: ["workstreams/co-expansion.md"], message: "digest: weekly 2026-W42", body: "# Week of Oct 12\n\n- Oct 15 payroll settled.\n- Jonah Pell gave notice; last day Nov 13.\n- Colorado plan moved forward ([[workstreams/co-expansion]]).\n" },
  { path: "timeline/daily/2026-10-23.md", day: "2026-10-23", id: "timeline-2026-10-23", type: "timeline_daily", links: [], message: "digest: daily 2026-10-23", body: "# Fri Oct 23\n\n- Owen Mercer's last day.\n" },
];

const cents = (c: number) => `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Two knowledge notes the team keeps, written from the world's own rows so they agree with every screen: the expense
 * policy (the stored policy version and the published rates it applies) and the payroll tax calendar (the filing and
 * deposit rows of the compliance calendar from the seed week on). The agent reads them with memory.search and cites them.
 */
async function knowledgeDocs(db: SeedContext["db"]): Promise<typeof MEMORY_DOCS> {
  const [pol] = await db.select().from(expensePolicies).where(eq(expensePolicies.companyId, CO)).orderBy(asc(expensePolicies.version));
  const out: typeof MEMORY_DOCS = [];
  if (pol) {
    const r = JSON.parse(pol.rulesJson) as Record<string, number>;
    const [m1, m2] = EXPENSE_RATES.mileageCentsPerMileX10;
    const [l1, l2] = EXPENSE_RATES.lodgingCents;
    const day = (d: string) => payroll.shortDay(d, 0);
    const on = pol.effectiveFrom;
    const src = (what: string) => `(${on}, src: ${what})`;
    const company = `Larkspur expense policy v${pol.version}`;
    out.push({ path: "knowledge/facts/expense-policy.md", day: on, id: "fact-expense-policy", type: "fact", links: ["entities/company/cmp_larkspur.md"], message: `fact: expense policy v${pol.version}`,
      body: [`# Expense policy (version ${pol.version}, effective ${day(on)})`, "",
        "What Weft checks on every claim before a person decides it. Policy limits are the company's; rates come from the IRS and GSA.", "",
        `- Receipts: lodging always needs one, and so does any other expense of ${cents(r.receiptRequiredAtCents!)} or more ${src("IRS Publication 463, chapter 5")}`,
        `- Client and team meals: up to ${cents(r.mealsPerPersonCents!)} per person, counting everyone at the table; list the attendees and the business purpose ${src(company)}`,
        `- Hotel stays: up to the standard night rate, ${cents(l1!.cents)} a night through ${day(l1!.to)} and ${cents(l2!.cents)} from ${day(l2!.from)} ${src("GSA per diem bulletin FTR 27-01")}`,
        `- Meals on a trip: ${cents(r.perDiemMealsCents!)} a day, ${cents(r.perDiemTravelDayCents!)} on the first and last day ${src("GSA per diem bulletin FTR 27-01")}`,
        `- Mileage: the IRS standard rate on the day of the drive, ${m1!.centsPerMileX10 / 10} cents a mile through ${day(m1!.to)} and ${m2!.centsPerMileX10 / 10} cents from ${day(m2!.from)} ${src("IRS standard mileage rates for 2026")}`,
        `- Software: up to ${cents(r.softwareMonthlyCents!)} a month per tool ${src(company)}`,
        `- Equipment over ${cents(r.equipmentPreApprovalCents!)} needs a pre-approval reference ${src(company)}`,
        `- Claims over ${cents(r.secondApproverOverCents!)} get a second reviewer after the approver ${src(company)}`,
        `- Submit within ${r.accountableWindowDays} days of the expense; later claims can only be declined or paid as taxable wages ${src("IRS Publication 15, section 5, accountable plans")}`,
        `- California employees are reimbursed for necessary business expenses even above a limit, and the approver decides whether the purchase was necessary ${src("California Labor Code 2802")}`, ""].join("\n") });
  }
  const rows = (await db.select().from(complianceItems).where(eq(complianceItems.companyId, CO)).orderBy(asc(complianceItems.dueOn), asc(complianceItems.id)))
    .filter((x) => (x.kind === "filing" || x.kind === "deposit") && x.dueOn >= "2026-10-19" && x.dueOn <= "2027-02-28");
  if (rows.length) {
    const byDay = new Map<string, string[]>();
    for (const x of rows) byDay.set(x.dueOn, [...(byDay.get(x.dueOn) ?? []), x.title]);
    out.push({ path: "knowledge/facts/payroll-tax-calendar.md", day: "2026-10-19", id: "fact-payroll-tax-calendar", type: "fact", links: ["entities/agencies/irs-federal.md", "entities/agencies/ca_edd-combined.md"], message: "fact: payroll tax calendar",
      body: ["# Payroll tax calendar", "", "The filings and federal deposits due from the week of Oct 19, 2026, copied from the compliance calendar in Weft (Taxes & Compliance). Federal deposits are on the monthly schedule for 2026, per the IRS lookback notice.", "",
        ...[...byDay].map(([d, titles]) => `- ${longDay(d)}: ${titles.join("; ")} (2026-10-19, src: Weft compliance calendar)`), ""].join("\n") });
  }
  return out;
}

async function seedMemory(ctx: SeedContext, tail: { seq: number; hash: string; ts: string; command: string; summary: string }[]): Promise<number> {
  const mem = ctx.executor.memory as unknown as { root?: () => string | null; write: (w: unknown) => Promise<unknown>; appendTimeline: (b: unknown) => Promise<unknown> };
  if (typeof mem.root === "function" && !mem.root()) return 0;
  let commits = 0;
  const docs = [...await knowledgeDocs(ctx.db), ...MEMORY_DOCS].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const d of docs) {
    await ctx.clock.set(pt(d.day, 9), 0);
    try {
      await mem.write({ path: d.path, frontmatter: { id: d.id, type: d.type, aliases: [], links: d.links, sources: ["seed"], status: null, updated: d.day, taintedBy: null },
        body: d.body, message: d.message, author: { name: d.message.startsWith("digest") ? "svc_digest" : "Weft agent", email: "agent@weft.example" } });
      commits += 1;
    } catch { /* a memory guard refused the file: skip it rather than fail the seed */ }
  }
  // The raw timeline bullets for the most recent actions; the last one carries the chain head so git does not lag.
  for (const a of tail.slice(-25)) {
    await mem.appendTimeline({ at: a.ts, command: a.command, text: a.summary, importance: 1, source: `action:${a.seq}`, chainHead: { seq: a.seq, hash: a.hash } });
    commits += 1;
  }
  return commits;
}

// ---- entry point --------------------------------------------------------------------------------------------------

export interface RichOptions {
  /** Replay the recorded showcase runs (./showcase.ts) as the last step. On by default; the recorder turns it off to
   * build the world the runs are recorded on. A missing fixture file leaves the world without them. */
  showcase?: boolean;
  /** Another fixture file than the committed one (the recorder checks a new recording with it). */
  showcaseFixture?: string;
}

export async function seedRichProfile(ctx: SeedContext, opts: RichOptions = {}): Promise<RichSummary> {
  let L!: Layer;
  let tail: Awaited<ReturnType<Layer["flushActions"]>> = [];
  const fixture = opts.showcase === false ? null : readShowcaseFixture(opts.showcaseFixture);
  const blobMode = seedBlobMode(ctx.executor);
  await withWriteLock(() => ctx.db.transaction(async (tx) => {
    L = new Layer(tx, createSimulators({ db: tx, clock: ctx.clock }), ctx.clock);
    const ws = await tx.select().from(workers).orderBy(asc(workers.id));
    await seedHistory(L);
    await seedTimeOffHistory(L, ws);
    await seedDecidedProposals(L, ws);
    await seedPeopleRecords(L, ws);
    await seedMoneyAndCompliance(L, ws);
    const api: MotionApi = {
      tx, dataDir: ctx.dataDir, blobMode, bump: (t, n) => L.bump(t, n), chat: (c, a, t, ts) => L.chat(c, a, t, ts),
      proposal: (p) => L.proposal(p as Parameters<Layer["proposal"]>[0]), preview: (c, a) => L.preview(c, a), action: (a) => L.action(a as unknown as PendingAction),
    };
    await seedRichMotion(api, ws);
    await seedTurnover({ tx, bump: (t, n) => L.bump(t, n), action: (a) => L.action(a as unknown as PendingAction) });
    await seedImportedPayHistory(tx, (t, n) => L.bump(t, n));
    await terminateLeaverEnrollments(tx);
    await seedLifeEventHistory(L);
    await numberRichEmployees(L);
    tail = await L.flushActions();
    if (fixture) {
      for (const [t, n] of Object.entries(await applyShowcaseRows(tx, fixture))) L.bump(`showcase.${t}`, n);
      L.bump("showcase.run_files", await applyShowcaseFiles({ tx, dataDir: ctx.dataDir, mode: blobMode }, fixture));
    }
  }));
  const commits = await seedMemory(ctx, tail);
  L.bump("memory_commits", commits);
  if (fixture) L.bump("showcase.memory_commits", await applyShowcaseMemory({ clock: ctx.clock, memory: ctx.executor.memory }, fixture));
  return L.counts;
}
