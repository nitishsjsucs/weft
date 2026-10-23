// The "rich" seed profile: a deterministic layer on top of seedWorld() that fills history and motion so every screen
// has data (WEFT_SEED_PROFILE=rich, the default for `pnpm dev`). Tests, `pnpm e2e`, `pnpm demo` and the eval worlds
// keep the base profile, so their digests and golden numbers never see this layer.
//
// Rules: it only adds rows, never edits a planted row (the four pay runs, Ruth's coverage conflict, the 8 expenses in
// review, the DE 2088 flow, Noor's offer, the open October reconciliation). Ids come from the same id counters the app
// uses, timestamps are fixed sim-clock instants before the seed time, every name ends with (demo) where it is a name
// of record, and nothing here calls a model: agent runs are scripted-provider transcripts at zero cost.
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { PREBUILT } from "@weft/routines";
import {
  actions, agentRuns, benefitEnrollments, enrollmentWindows, itAccounts, lifeEvents, offers, screeningOrders, approvalAudit, contractorPayments, documents, employerTaxRates, filings, handoffCases, notices, offboardingCases, offboardingSteps,
  onboardingTasks, paychecks, payRates, payrollRuns, proposals, routineRuns, runSteps, simAgencyMail, simChatMessages, simRailTransfers, simRegistrations,
  taxAccounts, taxProfiles, timeOffAssignments, timeOffLedger, timeOffRequests, workers, withWriteLock, type DbTx,
} from "@weft/db";
import { canonicalJson, commands, newId, offboarding, payroll, sha256Hex } from "@weft/core";
import type { ExecContext, Preview, SimClock, Simulators } from "@weft/contracts";
import { createSimulators } from "@weft/sim";
import type { SeedContext } from "../context";
import { seedRichMotion, type MotionApi } from "./motion";
import { seedBlobMode } from "../blobs";
import { seedImportedPayHistory } from "./pay-history";
import { enrollLeaver, seedTurnover, terminateLeaverEnrollments } from "./turnover";
import { SEED_CHAT } from "../it";

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
const name = (w: Pick<W, "firstName" | "lastName">) => `${w.firstName} ${w.lastName} (demo)`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const isWeekday = (d: string) => weekday(d) !== 0 && weekday(d) !== 6;
const runKey = (routineId: string, triggerRef: string) => createHash("sha256").update(JSON.stringify({ routine_id: routineId, trigger_ref: triggerRef })).digest("hex");
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"]);

/** Counts written by the layer, for the CLI log and the tests. */
export interface RichSummary { [table: string]: number }

// ---- agent runs, routine runs, proposals and the action log ------------------------------------------------------

interface ToolUse { name: string; args: Record<string, unknown>; data: unknown }
interface RunSpec {
  at: string; trigger: "chat" | "routine"; routineId?: string; triggerRef?: string; onBehalfOf: string | null;
  tools: ToolUse[]; final: string; checklist?: { id: string; label: string; passed: boolean }[]; status?: "done" | "refused";
}

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

  /** Runs a read command (R0) as Dana would, so a planted post quotes the figures the live tool returns. */
  async read<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const cmd = commands.find((c) => c.name === command);
    if (!cmd || cmd.effect !== "read" || !this.sims || !this.clock) throw new Error(`rich seed: ${command} is not a read`);
    const ctx: ExecContext = { companyId: CO, principal: { id: "usr_dana", kind: "human", role: "owner" }, onBehalfOf: null, surface: "human_ui", agentKind: null,
      run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: this.clock.now() };
    const deps = { tx: this.tx, sims: this.sims, clock: this.clock, newId: (prefix: string) => newId(this.tx, prefix as Parameters<typeof newId>[1]),
      resolveCredential: async () => { throw new Error("rich seed: reads never touch the vault"); } };
    return (await cmd.run(cmd.input.parse(args), ctx, deps as never)).data as T;
  }

  async run(spec: RunSpec): Promise<{ runId: string; routineRunId: string | null }> {
    const { tx } = this;
    const runId = await newId(tx, "run_");
    let routineRunId: string | null = null;
    if (spec.trigger === "routine") {
      routineRunId = await newId(tx, "rtr_");
      const ref = spec.triggerRef ?? `cron:${spec.at}`;
      await tx.insert(routineRuns).values({
        id: routineRunId, routineId: spec.routineId!, runKey: runKey(spec.routineId!, ref), triggerRef: ref, status: "done", agentRunId: runId,
        summary: spec.final.slice(0, 400), leftForHumanJson: "[]", attended: false, costUsdMicros: 0, startedAt: spec.at, endedAt: spec.at,
      });
      this.bump("routine_runs");
    }
    const steps: (typeof runSteps.$inferInsert)[] = [];
    let n = 0;
    const step = (s: Omit<typeof runSteps.$inferInsert, "runId" | "n" | "createdAt">) => { n += 1; steps.push({ runId, n, createdAt: spec.at, ...s }); return n; };
    const usage = (input: number, output: number) => JSON.stringify({ input, cached: Math.floor(input * 0.4), cacheWrite: 0, output, reasoning: 0 });
    step({ stage: "assemble", kind: "context", outcome: "ok", resultJson: JSON.stringify({ promptKind: spec.trigger === "chat" ? "chat" : "routine", allowlist: spec.tools.map((t) => t.name.replace("__", ".")) }) });
    let input = 5_200 + spec.tools.length * 700;
    let output = 0;
    if (spec.tools.length) {
      const m = step({ stage: "model", kind: "model_call", outcome: "ok", usageJson: usage(input, 24 * spec.tools.length),
        resultJson: JSON.stringify({ provider: "scripted", stop: "tool_calls", text: "", toolCalls: spec.tools.map((t) => t.name), error: null, refusal: null, servedBy: "scripted" }) });
      output += 24 * spec.tools.length;
      spec.tools.forEach((t, i) => {
        step({ parentN: m, stage: "dispatch", kind: "tool_call", callId: `call_${runId}_${i + 1}`, toolName: t.name, toolArgsJson: JSON.stringify(t.args), outcome: "ok",
          resultJson: JSON.stringify({ output: JSON.stringify({ actionSeq: null, artifactRef: null, data: t.data }) }) });
      });
      input += 900;
    }
    const finalOut = Math.max(30, Math.round(spec.final.length / 4));
    output += finalOut;
    step({ stage: "model", kind: "model_call", outcome: "ok", usageJson: usage(input, finalOut),
      resultJson: JSON.stringify({ provider: "scripted", stop: "final", text: spec.final, toolCalls: [], error: null, refusal: spec.status === "refused" ? "guardrail" : null, servedBy: "scripted" }) });
    step({ stage: "terminal", kind: "verify", outcome: "ok", resultJson: JSON.stringify({ status: spec.status ?? "done", reason: spec.status === "refused" ? "REFUSED" : "DONE", ms: 1 }) });
    await tx.insert(runSteps).values(steps);
    await tx.insert(agentRuns).values({
      id: runId, companyId: CO, kind: "main", routineRunId, onBehalfOf: spec.onBehalfOf, trigger: routineRunId ? `routine:${routineRunId}` : "chat", attended: spec.trigger === "chat",
      provider: "scripted", model: "scripted", effort: "low", cacheKey: `weft:main:${spec.routineId ?? "chat"}:${CO}`, status: spec.status ?? "done",
      terminalReason: spec.status === "refused" ? "REFUSED" : "DONE", checklistJson: spec.checklist ? JSON.stringify(spec.checklist) : null,
      budgetJson: JSON.stringify({ steps: spec.trigger === "chat" ? 12 : 6, usd: 0.1, minutes: 10 }), stepsUsed: Math.max(1, spec.tools.length + 1),
      costUsdMicros: 0, tokensJson: JSON.stringify({ input: input * (spec.tools.length ? 2 : 1), cached: Math.floor(input * 0.4), cacheWrite: 0, output, reasoning: 0 }),
      summary: spec.final.slice(0, 600), createdAt: spec.at, endedAt: spec.at,
    });
    this.bump("agent_runs"); this.bump("run_steps", steps.length);
    return { runId, routineRunId };
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

/** Mondays from `from` to `to` inclusive. */
function mondays(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  while (weekday(d) !== 1) d = addDays(d, 1);
  for (; d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

async function seedAgentHistory(L: Layer, ws: W[]): Promise<void> {
  const emp = ws.filter((w) => w.type === "employee");
  // Pre-payroll review on each approval-deadline day, with the submit proposal Theo approved.
  const runs = await L.tx.select().from(payrollRuns).where(eq(payrollRuns.status, "processed")).orderBy(asc(payrollRuns.periodEnd));
  for (const run of runs) {
    // The run's stored totals (contracts TOTALS_FIELDS: { totalCost: { amount } }), worded by the live preview's formatter.
    const t = JSON.parse(run.totalsJson ?? "{}") as Record<string, { amount?: number } | undefined>;
    const cost = t.totalCost?.amount ?? 0;
    const bank = (t.netPay?.amount ?? 0) + (t.reimbursements?.amount ?? 0);
    const checks = await L.tx.select({ workerId: paychecks.workerId, status: paychecks.status }).from(paychecks).where(eq(paychecks.payrollRunId, run.id));
    const excludedNames = checks.filter((c) => c.status === "excluded").map((c) => { const w = ws.find((x) => x.id === c.workerId); return w ? name(w) : c.workerId; });
    const included = checks.length - excludedNames.length;
    const { title: headline, diff } = payroll.submitPreviewText({ run, included, totalCostCents: cost, bankCents: bank, excludedNames });
    const at = new Date(Date.parse(run.approvalDeadline) - 8 * 3_600_000).toISOString();
    const r = await L.run({ at, trigger: "routine", routineId: "rt_pre_payroll", onBehalfOf: "usr_theo", final: `Proposed: ${headline}. Explanations attached to the flagged paychecks.`,
      tools: [{ name: "payroll__get_run", args: { run_id: run.id }, data: { id: run.id, status: "draft" } }, { name: "payroll__submit_run", args: { run_id: run.id }, data: { proposed: true } }],
      checklist: [{ id: "explain", label: "explain flagged paychecks", passed: true }, { id: "submit", label: "propose payroll.submit_run", passed: true }] });
    const decidedAt = run.approvedAt ?? new Date(Date.parse(at) + 2 * 3_600_000).toISOString();
    await L.proposal({ at, command: "payroll.submit_run", args: { run_id: run.id }, subjectRef: run.id, risk: "R4", headline, diff, domain: "payroll", moneyCents: cost,
      evidence: [{ label: "Pay run", ref: run.id }], runId: r.runId, routineRunId: r.routineRunId, status: "executed", decidedBy: "usr_theo", decidedAt, onBehalfOf: "usr_theo",
      exec: { ts: decidedAt, actorKind: "human", actorId: "usr_theo", summary: `Submitted ${run.id}: ${included} paychecks, ${money(bank)} to the bank`, reversible: "no" } });
    L.action({ ts: run.processedAt ?? pt(run.payday, 6), actorKind: "system", actorId: "svc_events", command: "payroll.mark_processed", args: { run_id: run.id }, summary: `Processed ${run.id}: paychecks settled`, reversible: "no" });
  }
  // The NY DOL 2026 rate notice handled on Feb 14 (the notice row is planted and already resolved).
  {
    const at = "2026-02-14T17:30:00.000Z";
    const r = await L.run({ at, trigger: "routine", routineId: "rt_agency_notice", triggerRef: "event:notice.received:ntc_0001", onBehalfOf: "usr_dana",
      final: "Read the NY DOL 2026 UI rate notice (ntc_0001), checked the account and proposed the rate update with the notice as the source.",
      tools: [{ name: "notices__get", args: { notice_id: "ntc_0001" }, data: { agency: "ny_dol", kind: "rate_change" } }, { name: "tax__update_rate", args: { code: "sui", rate: "0.041", effective_from: "2026-01-01", source_notice_id: "ntc_0001" }, data: { proposed: true } }],
      checklist: [{ id: "rate", label: "propose tax.update_rate", passed: true }] });
    // Shaped like tax.update_rate itself: its input fields, risk R2, reversible through tax.revert_rate.
    const [ny] = await L.tx.select().from(taxAccounts).where(eq(taxAccounts.agency, "ny_dol"));
    const [nyRate] = await L.tx.select().from(employerTaxRates).where(eq(employerTaxRates.source, "notice:ntc_0001"));
    const args = { tax_account_id: ny?.id ?? "txa_ny_dol", code: "sui", rate: nyRate?.rate ?? "0.041", effective_from: nyRate?.effectiveFrom ?? "2026-01-01", source_notice_id: "ntc_0001" };
    await L.proposal({ at, command: "tax.update_rate", args, subjectRef: `${args.tax_account_id}:sui`, risk: "R2",
      headline: `Update NY SUI rate 3.80% to 4.10% effective Jan 1, 2026 on account ${ny?.accountNumber ?? "00-48172 6"}`, domain: "tax",
      diff: [{ label: "NY SUI rate", before: "3.80%", after: "4.10%" }], evidence: [{ label: "Notice", ref: "ntc_0001" }], runId: r.runId, reversible: true,
      routineRunId: r.routineRunId, status: "executed", decidedBy: "usr_dana", decidedAt: "2026-02-14T19:05:00.000Z",
      exec: { ts: "2026-02-14T19:05:00.000Z", actorKind: "human", actorId: "usr_dana", summary: `Updated NY SUI rate 3.80% to 4.10% effective 2026-01-01${nyRate ? ` (${nyRate.id})` : ""}`,
        reversible: nyRate ? "yes" : "no", reverse: nyRate ? { rate_id: nyRate.id } : undefined } });
  }
  // Chat runs a viewer can open from the agent panel and the run view.
  const chats: RunSpec[] = [
    { at: pt("2026-10-23", 10, 12), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "reports__query", args: { metric: "payroll_cost_by_month" }, data: { chart: { kind: "stacked_bar" } } }],
      final: "Payroll cost by month for 2026: January to August from the imported history of the previous provider, September and October from the runs Weft paid. The chart splits each month into gross pay, employer taxes and benefits." },
    { at: pt("2026-10-23", 10, 20), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "payroll__get_paycheck", args: { run_id: "pay_2026_10_30", worker: "Lena Brooks (demo)" }, data: { flags: ["GROSS_CHANGE"] } }, { name: "actions__list", args: { command: "people.set_pay_rate" }, data: { seq: 1 } }],
      final: "Lena Brooks (demo) has a gross change flag: her gross changed against the last processed run because the raise in action #1 took effect on Oct 16." },
    { at: pt("2026-10-22", 15, 4), trigger: "chat", onBehalfOf: "usr_theo", tools: [], status: "refused",
      final: "I can't approve anything: approvals are human-only and there is no approve tool. Open each card in the Inbox to review the diff, then approve or deny it yourself." },
    { at: pt("2026-10-21", 11, 40), trigger: "chat", onBehalfOf: "usr_sam", tools: [{ name: "time_off__balances", args: { worker: "Dana Whitfield (demo)" }, data: { policies: 2 } }],
      final: "Dana Whitfield (demo) has vacation and California sick leave balances on file; the Time off tab shows what is used, held and available." },
    { at: pt("2026-10-20", 9, 15), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "expenses__policy", args: {}, data: { version: 1 } }],
      final: "From the company expense policy: business meals have a per person limit, lodging always needs a receipt, and mileage is paid at the IRS rate." },
  ];
  for (const c of chats) await L.run(c);
  // Open hand-offs to a tax specialist, and one already resolved.
  const hand = [
    { kind: "tax_specialist", reason: "deposit_schedule_question", summary: "The IRS letter asks whether Larkspur (demo) moves to a semiweekly deposit schedule next year; a tax specialist should confirm the lookback period.", status: "open", createdAt: pt("2026-10-22", 10), subjectRef: "txa_0001" },
    { kind: "tax_specialist", reason: "multi_state_withholding", summary: "Noor Castellanos (demo) will work remotely from Colorado; confirm the CO withholding and FAMLI setup before her first payroll.", status: "acknowledged", createdAt: pt("2026-10-23", 14), subjectRef: "offr_0001", assignee: "usr_theo" },
    { kind: "hr_person", reason: "leave_question", summary: "Talia Brennan (demo) asked about paid family leave timing; Sam answered with the NY PFL guide.", status: "resolved", createdAt: pt("2026-09-08", 11), subjectRef: "wrk_0028", resolvedAt: pt("2026-09-09", 15), note: "Answered with the NY PFL guide (demo)." },
  ];
  for (const h of hand) {
    await L.tx.insert(handoffCases).values({ id: await newId(L.tx, "hnd_"), companyId: CO, kind: h.kind, reason: h.reason, subjectRef: h.subjectRef, workerId: null, summary: h.summary,
      evidenceJson: JSON.stringify([{ label: "Subject", ref: h.subjectRef }]), status: h.status, assigneePrincipalId: h.assignee ?? null, openedBy: AGENT, runId: null,
      createdAt: h.createdAt, resolvedAt: h.resolvedAt ?? null, resolutionNote: h.note ?? null });
    L.bump("handoff_cases");
  }
  // Routines that ran in a September trial and are paused now, plus the October chases. The milestone posts name the
  // people whose start date comes round in the week up to the post.
  function anniversaries(d: string): string {
    const year = Number(d.slice(0, 4));
    const hits = emp.filter((w) => w.status === "active" && w.startDate.slice(0, 4) < d.slice(0, 4) && !w.endDate)
      .filter((w) => { const on = `${d.slice(0, 4)}${w.startDate.slice(4)}`; return on > addDays(d, -7) && on <= d; })
      .map((w) => { const n = year - Number(w.startDate.slice(0, 4)); return `${name(w)}, ${n} ${n === 1 ? "year" : "years"}`; });
    return hits.length ? `Celebrating work anniversaries this week: ${hits.join("; ")}.` : "No work anniversaries this week, so nothing was posted.";
  }
  const trial: [string, string, string, string, string | null][] = [
    ["rt_expense_review", "2026-09-14", "Checked 6 claims against the policy: 5 within limits, 1 missing a receipt. Drafted the decisions for review.", "expenses__list", null],
    ["rt_expense_review", "2026-09-28", "Checked 4 claims against the policy: all within limits. Drafted the approvals for review.", "expenses__list", null],
    ["rt_milestones", "2026-09-21", anniversaries("2026-09-21"), "comms__send_message", "#general"],
    ["rt_milestones", "2026-10-05", anniversaries("2026-10-05"), "comms__send_message", "#general"],
    ["rt_open_enrollment", "2026-10-05", "Sent the first open enrollment reminder to the employees who have not opened the 2027 window.", "comms__send_email", null],
    ["rt_onboarding_nudge", "2026-10-21", "Reminded Mira Delgado (demo) to add a bank account; payroll is blocked until it is on file.", "comms__send_email", null],
  ];
  for (const [routineId, day, final, tool, channel] of trial) {
    const { at, triggerRef } = cronRun(routineId, day);
    const r = await L.run({ at, trigger: "routine", routineId, triggerRef, onBehalfOf: "usr_dana", final, tools: [{ name: tool, args: channel ? { channel } : {}, data: { ok: true } }] });
    if (channel && !final.startsWith("No work anniversaries")) {
      await L.chat(channel, "Weft agent", final, at);
      L.action({ ts: at, actorKind: "routine", actorId: AGENT, onBehalfOf: "usr_dana", agentRunId: r.runId, routineRunId: r.routineRunId, command: "comms.send_message", args: { channel, text: final }, summary: `Posted the work anniversaries to ${channel}`, reversible: "no" });
    }
  }
  // People ops chat spread over days.
  for (const [ch, author, text, at] of [
    ["#new-hires", "Weft agent", "Welcome Ana Sousa (demo) and Ben Ashdown (demo), who start today in Oakland. Accounts are ready.", pt("2026-10-01", 9)],
    ["#new-hires", "Weft agent", "Welcome Mira Delgado (demo), Robotics Engineer, starting today in Oakland.", pt("2026-10-19", 9)],
    ["#payroll", "Theo Marsh (demo)", "Sep 30 payroll approved. Thanks for the quick review.", pt("2026-09-28", 14)],
    ["#people-ops", "Sam Okafor (demo)", "Reminder: managers, please decide pending time-off requests before Friday.", pt("2026-10-14", 10)],
    ["#leadership", "Dana Whitfield (demo)", "Colorado hiring plan is on track; registrations go in before Noor starts.", pt("2026-10-20", 16)],
  ] as const) await L.chat(ch, author, text, at);
  // The base world's channel posts carry the seed time; with a year of history around them they would read as the
  // newest posts, so here each one gets the day it talks about (Ana and Ben started Oct 1, the Oct 15 run settled
  // that day, open enrollment opened Oct 5). The channel lists in time order.
  const dated: Record<string, string> = {
    "Reminder: the Brooklyn Studio demo day is Thursday. Snacks on the third floor.": pt("2026-10-19", 10),
    "Austin Yard fleet hit 1,000 autonomous pallet moves this week.": pt("2026-10-23", 16),
    "Open enrollment questions can go in this channel.": pt("2026-10-05", 10, 30),
    "The Oct 15 payroll settled. Next approval deadline is Wed Oct 28 at 5 pm PT.": pt("2026-10-15", 14),
    "Welcome Ana and Ben to Larkspur (demo)!": pt("2026-10-01", 9, 30),
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
    { at: pt("2026-07-30", 9), command: "comms.send_message", args: { channel: "#general", text: "Summer hours start Monday (demo)." }, subjectRef: "#general", risk: "R1", headline: "Post the summer hours note in #general", kind: "suggestion", domain: "comms", status: "dismissed", decidedBy: "usr_dana", decidedAt: pt("2026-07-30", 12) },
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

/** The routines that report on people: the weekly digest, the monthly exec report, the weekly cost by state and the
 * ready check before each 2026 hire. They run after the turnover and the portal hires are planted, from the full worker
 * list, and quote reports.query itself (headcount at the end of the reported month, hires and departures in it), so a
 * post in #leadership agrees with the Reports page. They stay disabled (a running dev clock never fires a live model
 * call), but the gallery and their detail pages show real past runs. */
async function seedReportHistory(L: Layer): Promise<void> {
  const all = await L.tx.select().from(workers).orderBy(asc(workers.id));
  const emp = all.filter((w) => w.type === "employee" && w.status !== "draft");
  const onRoll = (d: string) => emp.filter((w) => w.startDate <= d && (!w.endDate || w.endDate >= d));
  const short = (d: string) => payroll.shortDay(d, 2026);
  for (const day of mondays("2026-08-03", "2026-10-19")) {
    const at = pt(day, 9);
    const active = onRoll(day).length;
    const joined = emp.filter((w) => w.startDate > addDays(day, -7) && w.startDate <= day);
    const left = emp.filter((w) => w.endDate && w.endDate >= addDays(day, -7) && w.endDate < day);
    const text = `Weekly people digest (demo): ${active} employees. New this week: ${joined.length ? joined.map(name).join(", ") : "none"}. `
      + `Left last week: ${left.length ? left.map(name).join(", ") : "none"}. Open onboarding items and time-off requests are listed in Weft.`;
    const r = await L.run({ at, trigger: "routine", routineId: "rt_people_digest", onBehalfOf: "usr_dana", final: `Posted the weekly digest to #people-ops for the week of ${short(day)}: ${active} employees.`,
      tools: [{ name: "people__search", args: { status: "active" }, data: { count: active } }, { name: "comms__send_message", args: { channel: "#people-ops" }, data: { posted: true } }],
      checklist: [{ id: "posted", label: "post the digest in #people-ops", passed: true }] });
    await L.chat("#people-ops", "Weft agent", text, at);
    L.action({ ts: at, actorKind: "routine", actorId: AGENT, onBehalfOf: "usr_dana", agentRunId: r.runId, routineRunId: r.routineRunId, command: "comms.send_message", args: { channel: "#people-ops", text }, summary: "Posted the weekly people digest to #people-ops", reversible: "no" });
  }
  type Move = { period: string; hires: number; departures: number; headcount_end: number };
  const moves = (await L.read<{ rows: Move[] }>("reports.query", { metric: "hires_and_departures_by_month", from: "2026-01-01", to: "2026-09-30" })).rows;
  for (const mv of moves) {
    const [y, mo] = mv.period.split("-").map(Number) as [number, number];
    // The 1st of the next month at the routine's own slot (it runs on a weekend 1st too).
    const day = new Date(Date.UTC(y, mo, 1, 12)).toISOString().slice(0, 10);
    const slot = cronRun("rt_monthly_exec_report", day);
    const label = new Date(`${mv.period}-15T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const final = `Posted the ${label} exec report to #leadership: ${mv.headcount_end} employees at month end (${mv.hires} joined, ${mv.departures} left), payroll cost by month and open compliance items.`;
    const r = await L.run({ ...slot, trigger: "routine", routineId: "rt_monthly_exec_report", onBehalfOf: "usr_dana", final,
      tools: [{ name: "reports__query", args: { metric: "hires_and_departures_by_month" }, data: { period: mv.period, hires: mv.hires, departures: mv.departures, headcount_end: mv.headcount_end } },
        { name: "reports__query", args: { metric: "payroll_cost_by_month" }, data: { rows: 1 } }, { name: "comms__send_message", args: { channel: "#leadership" }, data: { posted: true } }] });
    await L.chat("#leadership", "Weft agent", `${label} exec report (demo): ${mv.headcount_end} employees at month end, ${mv.hires} joined, ${mv.departures} left. Cost by month and compliance items are in Weft.`, slot.at);
    L.action({ ts: slot.at, actorKind: "routine", actorId: AGENT, onBehalfOf: "usr_dana", agentRunId: r.runId, routineRunId: r.routineRunId, command: "comms.send_message", args: { channel: "#leadership" }, summary: `Posted the ${label} exec report to #leadership`, reversible: "no" });
  }
  for (const day of mondays("2026-08-03", "2026-10-19")) {
    const states = [...new Set(onRoll(day).map((w) => w.workState ?? "CA"))].sort();
    await L.run({ ...cronRun("rt_weekly_cost_by_state", day), trigger: "routine", routineId: "rt_weekly_cost_by_state", onBehalfOf: "usr_theo",
      final: `Payroll cost by state for the week of ${short(day)}: ${states.join(", ")}. No state moved more than the alert threshold.`,
      tools: [{ name: "reports__query", args: { metric: "payroll_cost_by_state" }, data: { states: states.length } }] });
  }
  // One ready check per slot (the routine's own weekday 9:00), naming every hire it covered.
  const ready = new Map<string, W[]>();
  for (const w of emp.filter((x) => x.startDate >= "2026-01-05" && x.startDate <= "2026-10-26")) {
    let day = addDays(w.startDate, -3);
    while (!isWeekday(day)) day = addDays(day, -1);
    ready.set(day, [...(ready.get(day) ?? []), w]);
  }
  for (const [day, hires] of [...ready.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const each = hires.map((w) => `${name(w)} for ${short(w.startDate)}`);
    await L.run({ ...cronRun("rt_new_hire_ready", day), trigger: "routine", routineId: "rt_new_hire_ready", onBehalfOf: "usr_sam",
      final: `Ready: ${each.join(" and ")}. Offer signed, W-4 and state form in, accounts created, laptop shipped.`,
      tools: hires.map((w) => ({ name: "onboarding__ready_check", args: { worker_id: w.id }, data: { ready: true, open: 0 } })) });
  }
}

/** The slot a routine's own cron fires at on `day`, or on the latest day before it the cron fires (the PREBUILT
 * trigger, read as minute, hour, day of month and weekday in PT), so a seeded run never sits at an hour or on a day its
 * schedule could not produce. An hourly cron takes `hour`. */
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
/** A run of a cron routine on `day`: its slot and the trigger ref the engine writes for that slot. */
const cronRun = (routineId: string, day: string, hour?: number) => { const at = cronSlot(routineId, day, hour); return { at, triggerRef: `cron:${at}` }; };

/** One or two past runs for each routine the gallery shows that has none yet, so no card reads "Last run never". They
 * are scripted transcripts at $0.00 and every routine keeps its enabled flag: nothing here turns on live firing. Each
 * summary names only what the rest of the layer planted (the offers, Mira's window, Odette's course, the checks). Cron
 * routines run at their own slots; event routines carry the event and its subject in the trigger ref. */
async function seedQuietRoutines(L: Layer): Promise<void> {
  const all = await L.tx.select().from(workers).orderBy(asc(workers.id));
  const who = (first: string) => { const w = all.find((x) => x.firstName === first); return w ? name(w) : `${first} (demo)`; };
  const idOf = (first: string) => all.find((x) => x.firstName === first)?.id ?? first.toLowerCase();
  const contractors = all.filter((w) => w.type === "contractor" && w.status === "active").length;
  const offerOf = async (first: string) => (await L.tx.select().from(offers).where(eq(offers.candidateFirst, first)))[0];
  const marisol = await offerOf("Marisol"), tess = await offerOf("Tess"), tobias = await offerOf("Tobias");
  const [tobiasCheck] = tobias ? await L.tx.select().from(screeningOrders).where(eq(screeningOrders.offerId, tobias.id)) : [];
  const [benefitCharges] = await L.tx.select().from(notices).where(eq(notices.formCode, "DE 428T"));
  // The Austin office routine: Lucia Ferrante (demo), the seasonal Austin Yard technician, was its one Austin hire.
  const austin = all.find((w) => w.workplaceId === "wkp_austin" && w.startDate >= "2026-01-01" && w.type === "employee");
  // One of the requests still waiting, routed the way the time-off engine routed it.
  const [pending] = await L.tx.select().from(timeOffRequests).where(eq(timeOffRequests.status, "pending")).orderBy(asc(timeOffRequests.createdAt));
  const pendingWho = pending ? all.find((w) => w.id === pending.workerId) : undefined;
  const approver = pending?.approverPrincipalId === "usr_imani" ? "Imani Ferreira (demo)" : "Dana Whitfield (demo)";
  const short = (d: string) => payroll.shortDay(d, 2026);
  const ev = (event: string, subject: string, at: string) => ({ at, triggerRef: `event:${event}:${subject}` });
  // A marriage reported in September whose 30-day window closed with no changes: what the life-event routine last saw.
  const kofi = all.find((w) => w.firstName === "Kofi" && w.lastName === "Mensah");
  let lifeWindow: { id: string; closesOn: string; who: string } | null = null;
  if (kofi) {
    const eventId = await newId(L.tx, "lev_");
    const windowId = await newId(L.tx, "ewn_");
    await L.tx.insert(enrollmentWindows).values({ id: windowId, companyId: CO, workerId: kofi.id, kind: "life_event", lifeEventId: eventId, opensOn: "2026-09-14", closesOn: "2026-10-14", status: "closed", remindersSent: 3, createdAt: pt("2026-09-14", 9) });
    await L.tx.insert(lifeEvents).values({ id: eventId, workerId: kofi.id, kind: "marriage", eventDate: "2026-09-12", note: "", status: "closed_no_change", reportedBy: "usr_sam", reportedAt: pt("2026-09-14", 9), windowId });
    L.bump("life_events"); L.bump("enrollment_windows");
    lifeWindow = { id: windowId, closesOn: "2026-10-14", who: name(kofi) };
  }
  const runs: [string, { at: string; triggerRef: string }, string, string][] = [
    ["rt_ats_hire", ev("offer.imported", marisol?.id ?? "marisol", pt("2026-10-19", 10, 2)), "integrations__apply_delivery", `Greenhouse marked ${who("Marisol")} hired; drafted the offer in Weft for Sam to review and send.`],
    ["rt_ats_hire", ev("offer.imported", tess?.id ?? "tess", pt("2026-10-23", 15, 2)), "integrations__apply_delivery", `Greenhouse marked ${who("Tess")} hired; drafted the offer in Weft for Sam to review. It is still a draft.`],
    ["rt_benefits_window_reminders", cronRun("rt_benefits_window_reminders", "2026-10-20"), "comms__send_email", `Reminded ${who("Mira")} that her new-hire benefits window is open until Nov 18.`],
    ["rt_compliance_reminders", cronRun("rt_compliance_reminders", "2026-10-23"), "compliance__post_reminders", "Posted the filing and deposit deadlines due in the next 14 days to #payroll."],
    ["rt_compliance_training", cronRun("rt_compliance_training", "2026-10-23"), "training__assign", `Assigned the New York harassment prevention course to ${who("Odette")}, due within 30 days of her Nov 2 start.`],
    ["rt_compliance_uploads", ev("notice.uploaded", benefitCharges?.id ?? "de428t", pt("2026-09-21", 10)), "notices__get", "Read the EDD statement of benefit charges and left it in review for Dana; an uploaded notice never changes a record without approval."],
    ["rt_contractor_forms", cronRun("rt_contractor_forms", "2026-10-19"), "contractors__list_forms", `Checked the contractors' tax forms: a current W-8BEN is on file for all ${contractors}.`],
    ["rt_exec_briefing", cronRun("rt_exec_briefing", "2026-10-19"), "reports__query", "Sent Dana the Monday briefing: approvals waiting, people out this week and the Oct 30 payroll deadline."],
    ["rt_first_day_message", cronRun("rt_first_day_message", "2026-10-01"), "comms__send_email", `Sent ${who("Ana")} and ${who("Ben")} their first-day message: manager, desk and the #new-hires channel.`],
    ["rt_first_day_message", cronRun("rt_first_day_message", "2026-10-19"), "comms__send_email", `Sent ${who("Mira")} her first-day message: manager, desk and the #new-hires channel.`],
    ...(austin ? [["rt_laptop_hand_delivery", ev("worker.created", austin.id, austin.createdAt), "comms__send_message",
      `${name(austin)} was added for the Austin Yard, so I asked in #new-hires for her laptop to be hand delivered on her first day, ${short(austin.startDate)}.`] as [string, { at: string; triggerRef: string }, string, string]] : []),
    ...(lifeWindow ? [["rt_life_event_window", ev("enrollment_window.closed", lifeWindow.id, pt(addDays(lifeWindow.closesOn, 1), 6)), "benefits__list_life_events",
      `${lifeWindow.who}'s marriage window closed on ${short(lifeWindow.closesOn)} with no election changes, so nothing was filed with the carrier.`] as [string, { at: string; triggerRef: string }, string, string]] : []),
    ["rt_memory_digest", cronRun("rt_memory_digest", "2026-10-19", 7), "memory__write", "Wrote the weekly memory digest for the week of Oct 12: payroll settled, a resignation and the Colorado plan."],
    ...(tobias && tobiasCheck ? [["rt_screening_follow_up", ev("offer.accepted", idOf("Tobias"), tobias.acceptedAt ?? pt("2026-10-21", 10)), "screening__list",
      `${who("Tobias")} accepted his offer, so I proposed the standard background check. It was ordered ${short(tobiasCheck.createdAt.slice(0, 10))} and is pending with an estimate of ${short(tobiasCheck.etaOn ?? "2026-10-30")}.`] as [string, { at: string; triggerRef: string }, string, string]] : []),
    ["rt_thirty_day_checkin", cronRun("rt_thirty_day_checkin", "2026-04-01"), "comms__send_email", `Reminded Sam of the 30-day check-in for ${who("Lucia")}, who started on Mar 2.`],
    ...(pending && pendingWho ? [["rt_time_off_requests", ev("time_off.request.created", pending.id, pending.createdAt), "time_off__list_requests",
      `Checked ${name(pendingWho)}'s request for ${short(pending.startAt)}${pending.endAt !== pending.startAt ? ` to ${short(pending.endAt)}` : ""} against the balance and team coverage and left the decision with ${approver}.`] as [string, { at: string; triggerRef: string }, string, string]] : []),
  ];
  for (const [routineId, { at, triggerRef }, tool, final] of runs) {
    await L.run({ at, trigger: "routine", routineId, triggerRef, onBehalfOf: "usr_dana", final, tools: [{ name: tool, args: {}, data: { ok: true } }] });
  }
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
      const why = approver === "usr_imani" ? "Manager Imani Ferreira (demo) decides" : "Dana Whitfield (demo) decides for managers without a Weft login";
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
      approverPrincipalId: "usr_dana", routingJson: JSON.stringify([{ principalId: "usr_dana", why: "Dana Whitfield (demo) decides for managers without a Weft login" }]),
      checksJson: "[]", decidedBy: "usr_dana", decidedAt: pt("2026-10-23", 11), decisionNote: "", createdAt: pt("2026-10-22", 9) });
    L.bump("time_off_requests");
  }
}

// ---- onboarding, documents and offboarding ----------------------------------------------------------------------

const DEMO_DOC = "DEMO DOCUMENT. Fictional company, fictional person, simulated signature. Not a real record.";

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
      const body = `${DEMO_DOC}\n\n${title}\nLarkspur Robotics (demo)\n${name(w)}\nSigned ${payroll.shortDay(signed.slice(0, 10), 0)}.`;
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
    ["final_pay", "Final pay included on the Jul 31 regular run, with accrued vacation paid out"], ["directory_suspend", "Suspended Workspace (sim) rafael.ostrander"],
    ["sso_deactivate", "Suspended SSO (sim) rafael.ostrander"], ["group_removal", "Removed 3 group memberships"], ["app_removal", "Removed Chat (sim) rafael.ostrander"],
    ["device_lock", "Locked 1 device; returned to the Oakland office on Jul 20"], ["cobra_notice", "COBRA notice emailed to rafael.ostrander@mail.example"], ["benefits_terminate", "Terminated 4 enrollments, effective through Jul 31"],
  ];
  for (const [kind, detail] of stepsDone) {
    await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: done, kind, status: "done", detail, doneAt: pt(kind === "final_pay" ? "2026-07-31" : "2026-07-18", 10) });
  }
  L.action({ ts: pt("2026-07-01", 10), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: leaverId, last_day: lastDay }, summary: `Started offboarding for Rafael Ostrander (demo) (${leaverId}), last day ${lastDay}`, reversible: "no" });
  // An open resignation, about half done.
  const jonah = ws.find((w) => w.id === "wrk_0016");
  if (jonah) {
    const open = await newId(tx, "ofb_");
    await tx.insert(offboardingCases).values({ id: open, companyId: CO, workerId: jonah.id, kind: "voluntary", lastDay: "2026-11-13", reasonNote: "Resigned to start a graduate program", status: "open", createdAt: pt("2026-10-16", 15) });
    const plan: [string, string, string][] = [
      ["final_pay", "pending", "Final pay on the Nov 13 regular run"], ["directory_suspend", "pending", "Scheduled for the end of the last day"], ["sso_deactivate", "pending", ""],
      ["group_removal", "done", "Removed from the release on-call group"], ["app_removal", "done", "Handed off test tooling ownership to Kofi Mensah (demo)"], ["device_lock", "pending", ""],
      ["cobra_notice", "done", "COBRA notice prepared and sent ahead of the last day"], ["benefits_terminate", "pending", "Coverage ends Nov 30"],
    ];
    for (const [kind, status, detail] of plan) await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: open, kind, status, detail, doneAt: status === "done" ? pt("2026-10-20", 11) : null });
    // What offboarding.start does to the person: they are offboarding from the day the case opens, with the last day as
    // their end date, so every screen and the agent's people reads agree with the open case.
    await tx.update(workers).set({ status: "offboarding", endDate: "2026-11-13", updatedAt: pt("2026-10-16", 15) }).where(eq(workers.id, jonah.id));
    L.action({ ts: pt("2026-10-16", 15), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: jonah.id, last_day: "2026-11-13" }, summary: `Started offboarding for ${name(jonah)} (${jonah.id}), last day 2026-11-13`, reversible: "no" });
  }
  // Owen Mercer (demo): the base world gives him a last day of Oct 23 (the carrier reconciliation reads it) and pays him
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
      ["directory_suspend", "done", `Suspended Workspace (sim) ${login}`], ["sso_deactivate", "done", `Suspended SSO (sim) ${login}`],
      ["group_removal", "done", "Removed group memberships"], ["app_removal", "done", `Removed Chat (sim) ${login}`],
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
    await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: a.split(":")[0]!, direction: "out", kind: "return_filing", body: canonicalJson({ form, period, note: "Filed from Weft (demo)" }),
      relatedNoticeId: null, confirmation, credentialName: null, ts: pt(day, 11) });
    L.bump("sim_agency_mail");
    L.action({ ts: pt(day, 11), actorKind: "human", actorId: "usr_theo", command: "tax.file_return", args: { form, period }, summary: `Filed ${form.replace(/^(ca|ny|tx)_/, "").toUpperCase()} for ${period} with ${a.split(":")[0]} (sim); accepted`, reversible: "no" });
    L.bump("filings");
  }
  // More agency notices across states and statuses, with their mail.
  const ntc: { agency: string; kind: string; form: string; title: string; at: string; status: string; body: string; resolution?: string; confirmation?: string }[] = [
    { agency: "tx_twc", kind: "rate_change", form: "C-1", title: "TWC 2026 tax rate notice", at: "2026-01-12T16:00:00.000Z", status: "resolved", body: "SIMULATED NOTICE (demo). The 2026 Texas unemployment tax rate for Larkspur Robotics (demo) is unchanged.", resolution: "Rate confirmed unchanged; no update needed." },
    { agency: "irs", kind: "deposit_schedule_change", form: "CP 136", title: "IRS deposit schedule notice", at: "2025-11-17T16:00:00.000Z", status: "resolved", body: "SIMULATED NOTICE (demo). Based on the lookback period your deposit schedule for 2026 is monthly.", resolution: "Deposit schedule confirmed as monthly; acknowledgement sent.", confirmation: "SIM-IRS-ACK-20251119" },
    { agency: "ca_edd", kind: "benefit_charge", form: "DE 428T", title: "EDD statement of benefit charges", at: "2026-09-21T16:00:00.000Z", status: "in_review", body: "SIMULATED NOTICE (demo). A former employee's claim was charged to the reserve account. Review the charge within 60 days." },
  ];
  for (const n of ntc) {
    const id = await newId(tx, "ntc_");
    const acc = [...acct.entries()].find(([key]) => key.startsWith(`${n.agency}:`))?.[1] ?? null;
    await tx.insert(notices).values({ id, companyId: CO, agency: n.agency, kind: n.kind, formCode: n.form, title: n.title, receivedAt: n.at, respondBy: n.status === "in_review" ? "2026-11-20" : null,
      status: n.status, taxAccountId: acc, fileName: `${n.agency.toUpperCase()}_${n.form.replace(/\W/g, "")}.txt`, bodyText: n.body, extractedJson: null, draftsJson: "[]",
      resolutionJson: n.resolution ? JSON.stringify({ note: n.resolution }) : null, responseConfirmation: n.confirmation ?? null, source: "simulated" });
    await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: n.agency, direction: "in", kind: "notice", body: n.body, relatedNoticeId: id, confirmation: null, credentialName: null, ts: n.at });
    if (n.confirmation) await tx.insert(simAgencyMail).values({ id: await newId(tx, "simm_"), agency: n.agency, direction: "out", kind: "notice_response", body: "Acknowledged (demo).", relatedNoticeId: id, confirmation: n.confirmation, credentialName: null, ts: new Date(Date.parse(n.at) + 2 * 86_400_000).toISOString() });
    L.bump("notices");
  }
  // The 2023 registrations as completed simulator records (Colorado stays for the tour).
  for (const [agency, type, at, num] of [["irs", "federal", "2023-02-20", "SIM-EIN"], ["ca_edd", "combined", "2023-03-06", "SIM-CA"], ["ny_dtf", "withholding", "2023-05-08", "SIM-NYW"], ["ny_dol", "unemployment", "2023-05-08", "SIM-NYU"], ["tx_twc", "unemployment", "2023-09-11", "SIM-TX"]] as const) {
    await tx.insert(simRegistrations).values({ id: await newId(tx, "sima_"), agency, companyId: CO, accountType: type, requestJson: JSON.stringify({ legal_name: "Larkspur Robotics (demo)" }), status: "complete", completeAt: pt(at, 10), accountNumber: `${num}-****`, fault: null });
    L.bump("sim_registrations");
  }
}

// ---- memory -------------------------------------------------------------------------------------------------------

const MEMORY_DOCS: { path: string; day: string; id: string; type: string; links: string[]; body: string; message: string }[] = [
  { path: "workstreams/q4-open-enrollment.md", day: "2026-10-05", id: "ws-q4-open-enrollment", type: "workstream", links: ["entities/people/wrk_0025"], message: "workstream: Q4 open enrollment",
    body: "# Q4 open enrollment (demo)\n\nOwner [[entities/people/wrk_0025|Sam Okafor]]. The 2027 window is open; stragglers get a nudge once the carrier rates are final.\n" },
  { path: "workstreams/co-expansion.md", day: "2026-10-20", id: "ws-co-expansion", type: "workstream", links: ["entities/people/wrk_0004", "entities/people/wrk_0001"], message: "workstream: Colorado expansion",
    body: "# Colorado expansion (demo)\n\nFirst Colorado hire starts Nov 2 under [[entities/people/wrk_0004|Imani Ferreira]]. Withholding and unemployment registrations are still to do. Sponsor [[entities/people/wrk_0001|Dana Whitfield]].\n" },
  // The guided tour opens the SUI rate notice procedure; this thread links it, so its Backlinks are not empty.
  { path: "workstreams/2026-agency-notices.md", day: "2026-09-25", id: "ws-2026-agency-notices", type: "workstream", links: ["knowledge/procedures/state-sui-rate-notice.md", "entities/agencies/ca_edd-combined.md"], message: "workstream: 2026 agency notices",
    body: "# 2026 agency notices (demo)\n\nIn February, New York's unemployment rate notice went through [[knowledge/procedures/state-sui-rate-notice|the state SUI rate notice procedure]]: the rate change waited for Dana's approval. The Texas rate notice confirmed an unchanged rate. The [[entities/agencies/ca_edd-combined|EDD]] statement of benefit charges is still in review.\n" },
  { path: "workstreams/october-payroll.md", day: "2026-10-23", id: "ws-october-payroll", type: "workstream", links: ["entities/people/wrk_0002", "knowledge/preferences/agent/autonomy.md"], message: "workstream: October payroll",
    body: "# October payroll (demo)\n\nOct 15 settled. The Oct 30 draft has four flagged paychecks; [[entities/people/wrk_0002|Theo Marsh]] approves by the Wednesday deadline. The agent proposes the submit and waits, as [[knowledge/preferences/agent/autonomy|the autonomy preference]] asks.\n" },
  { path: "comms/2026-10-weekly-digests.md", day: "2026-10-19", id: "comms-2026-10-digests", type: "thread", links: ["workstreams/october-payroll.md"], message: "comms: October digests",
    body: "# October digests (demo)\n\nThe weekly people digest posted every Monday in #people-ops. See [[workstreams/october-payroll]] for the payroll thread.\n" },
  { path: "timeline/monthly/2026-08.md", day: "2026-09-01", id: "timeline-2026-08", type: "timeline_monthly", links: [], message: "digest: monthly 2026-08", body: "# August 2026 (demo)\n\n- Weekly digests posted each Monday.\n- Two semi-monthly payrolls ran on the previous provider.\n" },
  { path: "timeline/monthly/2026-09.md", day: "2026-10-01", id: "timeline-2026-09", type: "timeline_monthly", links: ["workstreams/october-payroll.md"], message: "digest: monthly 2026-09", body: "# September 2026 (demo)\n\n- First two payrolls run in Weft (Sep 15 and Sep 30), approved by Theo.\n- Q3 deposits made on schedule.\n" },
  { path: "timeline/weekly/2026-W42.md", day: "2026-10-19", id: "timeline-2026-W42", type: "timeline_weekly", links: ["workstreams/co-expansion.md"], message: "digest: weekly 2026-W42", body: "# Week of Oct 12 (demo)\n\n- Oct 15 payroll settled.\n- Jonah Pell gave notice; last day Nov 13.\n- Colorado plan moved forward ([[workstreams/co-expansion]]).\n" },
  { path: "timeline/daily/2026-10-23.md", day: "2026-10-23", id: "timeline-2026-10-23", type: "timeline_daily", links: [], message: "digest: daily 2026-10-23", body: "# Fri Oct 23 (demo)\n\n- Owen Mercer's last day.\n- Agent answered two payroll questions in chat.\n" },
];

async function seedMemory(ctx: SeedContext, tail: { seq: number; hash: string; ts: string; command: string; summary: string }[]): Promise<number> {
  const mem = ctx.executor.memory as unknown as { root?: () => string | null; write: (w: unknown) => Promise<unknown>; appendTimeline: (b: unknown) => Promise<unknown> };
  if (typeof mem.root === "function" && !mem.root()) return 0;
  let commits = 0;
  for (const d of MEMORY_DOCS) {
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

export async function seedRichProfile(ctx: SeedContext): Promise<RichSummary> {
  let L!: Layer;
  let tail: Awaited<ReturnType<Layer["flushActions"]>> = [];
  await withWriteLock(() => ctx.db.transaction(async (tx) => {
    L = new Layer(tx, createSimulators({ db: tx, clock: ctx.clock }), ctx.clock);
    const ws = await tx.select().from(workers).orderBy(asc(workers.id));
    await seedAgentHistory(L, ws);
    await seedTimeOffHistory(L, ws);
    await seedDecidedProposals(L, ws);
    await seedPeopleRecords(L, ws);
    await seedMoneyAndCompliance(L, ws);
    const api: MotionApi = {
      tx, dataDir: ctx.dataDir, blobMode: seedBlobMode(ctx.executor), bump: (t, n) => L.bump(t, n), chat: (c, a, t, ts) => L.chat(c, a, t, ts),
      proposal: (p) => L.proposal(p as Parameters<Layer["proposal"]>[0]), preview: (c, a) => L.preview(c, a), run: (r) => L.run(r as unknown as RunSpec), action: (a) => L.action(a as unknown as PendingAction),
    };
    await seedRichMotion(api, ws);
    await seedTurnover({ tx, bump: (t, n) => L.bump(t, n), action: (a) => L.action(a as unknown as PendingAction) });
    await seedImportedPayHistory(tx, (t, n) => L.bump(t, n));
    await terminateLeaverEnrollments(tx);
    await seedReportHistory(L);
    await seedQuietRoutines(L);
    await numberRichEmployees(L);
    tail = await L.flushActions();
  }));
  const commits = await seedMemory(ctx, tail);
  L.bump("memory_commits", commits);
  return L.counts;
}
