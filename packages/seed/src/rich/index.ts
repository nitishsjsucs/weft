// The "rich" seed profile: a deterministic layer on top of seedWorld() that fills history and motion so every screen
// has data (WEFT_SEED_PROFILE=rich, the default for `pnpm dev`). Tests, `pnpm e2e`, `pnpm demo` and the eval worlds
// keep the base profile, so their digests and golden numbers never see this layer.
//
// Rules: it only adds rows, never edits a planted row (the four pay runs, Ruth's coverage conflict, the 8 expenses in
// review, the DE 2088 flow, Noor's offer, the open October reconciliation). Ids come from the same id counters the app
// uses, timestamps are fixed sim-clock instants before the seed time, every name ends with (demo) where it is a name
// of record, and nothing here calls a model: agent runs are scripted-provider transcripts at zero cost.
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  actions, agentRuns, approvalAudit, contractorPayments, documents, filings, handoffCases, notices, offboardingCases, offboardingSteps,
  onboardingTasks, payRates, payrollRuns, proposals, routineRuns, runSteps, simAgencyMail, simChatMessages, simRailTransfers, simRegistrations,
  taxAccounts, taxProfiles, timeOffAssignments, timeOffLedger, timeOffRequests, workers, withWriteLock, type DbTx,
} from "@weft/db";
import { canonicalJson, newId, payroll, sha256Hex } from "@weft/core";
import type { SeedContext } from "../context";
import { seedRichMotion, type MotionApi } from "./motion";
import { seedImportedPayHistory } from "./pay-history";
import { seedTurnover } from "./turnover";

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
  constructor(readonly tx: DbTx) {}
  bump(t: string, n = 1) { this.counts[t] = (this.counts[t] ?? 0) + n; }

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
    await this.tx.insert(proposals).values({
      id, companyId: CO, kind: p.kind ?? "action", command: p.command, argsJson: JSON.stringify(p.args), argsHash, subjectRef: p.subjectRef,
      subjectHash: null, risk: p.risk, headline: p.headline, diffJson: JSON.stringify(p.diff ?? []), contentJson: "[]", evidenceJson: JSON.stringify(p.evidence ?? []),
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
  // Weekly people digest every Monday since August, posted to #people-ops by the Weft agent.
  for (const day of mondays("2026-08-03", "2026-10-19")) {
    const at = pt(day, 9);
    const active = emp.filter((w) => w.startDate <= day && (!w.endDate || w.endDate >= day)).length;
    const text = `Weekly people digest (demo): ${active} employees. New this week: ${emp.filter((w) => w.startDate > addDays(day, -7) && w.startDate <= day).length}. Open onboarding items and time-off requests are listed in Weft.`;
    const r = await L.run({ at, trigger: "routine", routineId: "rt_people_digest", onBehalfOf: "usr_dana", final: `Posted the weekly digest to #people-ops for the week of ${day}.`,
      tools: [{ name: "people__search", args: { status: "active" }, data: { count: active } }, { name: "comms__send_message", args: { channel: "#people-ops" }, data: { posted: true } }],
      checklist: [{ id: "posted", label: "post the digest in #people-ops", passed: true }] });
    const msg = await L.chat("#people-ops", "Weft agent", text, at);
    L.action({ ts: at, actorKind: "routine", actorId: AGENT, onBehalfOf: "usr_dana", agentRunId: r.runId, routineRunId: r.routineRunId, command: "comms.send_message", args: { channel: "#people-ops", text }, summary: `Posted to #people-ops (${msg})`, reversible: "no" });
  }
  // Pre-payroll review on each approval-deadline day, with the submit proposal Theo approved.
  const runs = await L.tx.select().from(payrollRuns).where(eq(payrollRuns.status, "processed")).orderBy(asc(payrollRuns.periodEnd));
  for (const run of runs) {
    const t = JSON.parse(run.totalsJson ?? "{}") as { employerCostCents?: number; totalCostCents?: number; netCents?: number; count?: number };
    const cost = t.totalCostCents ?? t.employerCostCents ?? 0;
    const at = new Date(Date.parse(run.approvalDeadline) - 8 * 3_600_000).toISOString();
    const headline = `Submit payroll ${run.id} (${run.periodStart} to ${run.periodEnd}, payday ${run.payday})${cost ? `: total cost ${money(cost)}` : ""}`;
    const r = await L.run({ at, trigger: "routine", routineId: "rt_pre_payroll", onBehalfOf: "usr_theo", final: `Proposed ${headline}. Explanations attached to the flagged paychecks.`,
      tools: [{ name: "payroll__get_run", args: { run_id: run.id }, data: { id: run.id, status: "draft" } }, { name: "payroll__submit_run", args: { run_id: run.id }, data: { proposed: true } }],
      checklist: [{ id: "explain", label: "explain flagged paychecks", passed: true }, { id: "submit", label: "propose payroll.submit_run", passed: true }] });
    const decidedAt = run.approvedAt ?? new Date(Date.parse(at) + 2 * 3_600_000).toISOString();
    await L.proposal({ at, command: "payroll.submit_run", args: { run_id: run.id }, subjectRef: run.id, risk: "R4", headline, domain: "payroll", moneyCents: cost || undefined,
      evidence: [{ label: "Pay run", ref: run.id }], runId: r.runId, routineRunId: r.routineRunId, status: "executed", decidedBy: "usr_theo", decidedAt, onBehalfOf: "usr_theo",
      exec: { ts: decidedAt, actorKind: "human", actorId: "usr_theo", summary: `Submitted ${run.id} for funding (approved by Theo Marsh (demo))`, reversible: "no" } });
    L.action({ ts: run.processedAt ?? pt(run.payday, 6), actorKind: "system", actorId: "svc_events", command: "payroll.mark_processed", args: { run_id: run.id }, summary: `Processed ${run.id}: paychecks settled`, reversible: "no" });
  }
  // The NY DOL 2026 rate notice handled on Feb 14 (the notice row is planted and already resolved).
  {
    const at = "2026-02-14T17:30:00.000Z";
    const r = await L.run({ at, trigger: "routine", routineId: "rt_agency_notice", triggerRef: "event:ntc_0001", onBehalfOf: "usr_dana",
      final: "Read the NY DOL 2026 UI rate notice (ntc_0001), checked the account and proposed the rate update with the notice as the source.",
      tools: [{ name: "notices__get", args: { notice_id: "ntc_0001" }, data: { agency: "ny_dol", kind: "rate_change" } }, { name: "tax__update_rate", args: { notice_id: "ntc_0001" }, data: { proposed: true } }],
      checklist: [{ id: "rate", label: "propose tax.update_rate", passed: true }] });
    await L.proposal({ at, command: "tax.update_rate", args: { notice_id: "ntc_0001", jurisdiction: "NY", code: "sui" }, subjectRef: "ntc_0001", risk: "R3",
      headline: "Update the NY SUI rate from the NY DOL 2026 rate notice (ntc_0001)", domain: "tax", evidence: [{ label: "Notice", ref: "ntc_0001" }], runId: r.runId,
      routineRunId: r.routineRunId, status: "executed", decidedBy: "usr_dana", decidedAt: "2026-02-14T19:05:00.000Z",
      exec: { ts: "2026-02-14T19:05:00.000Z", actorKind: "human", actorId: "usr_dana", summary: "Updated the NY SUI rate from ntc_0001; notice resolved", reversible: "no" } });
  }
  // Chat runs a viewer can open from the agent panel and the run view.
  const chats: RunSpec[] = [
    { at: pt("2026-10-23", 10, 12), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "reports__query", args: { metric: "payroll_cost_by_month" }, data: { chart: { kind: "stacked_bar" } } }],
      final: "Payroll cost by month for 2026: January to August from the imported history of the previous provider, September and October from the runs Weft paid. The chart splits each month into gross pay, employer taxes and benefits." },
    { at: pt("2026-10-23", 10, 20), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "payroll__get_paycheck", args: { run_id: "pay_2026_10_30", worker: "Lena Brooks (demo)" }, data: { flags: ["GROSS_CHANGE"] } }, { name: "actions__list", args: { command: "people.set_pay_rate" }, data: { seq: 1 } }],
      final: "Lena Brooks (demo) is flagged GROSS_CHANGE: her gross changed against the last processed run because the raise in action #1 took effect on Oct 16." },
    { at: pt("2026-10-22", 15, 4), trigger: "chat", onBehalfOf: "usr_theo", tools: [], status: "refused",
      final: "I can't approve anything: approvals are human-only and there is no approve tool. Open each card in the Inbox to review the diff, then approve or deny it yourself." },
    { at: pt("2026-10-21", 11, 40), trigger: "chat", onBehalfOf: "usr_sam", tools: [{ name: "time_off__balances", args: { worker: "Dana Whitfield (demo)" }, data: { policies: 2 } }],
      final: "Dana Whitfield (demo) has vacation and California sick leave balances on file; the Time off tab shows what is used, held and available." },
    { at: pt("2026-10-20", 9, 15), trigger: "chat", onBehalfOf: "usr_dana", tools: [{ name: "expenses__policy", args: {}, data: { version: 1 } }],
      final: "From the company expense policy: business meals have a per person limit, lodging always needs a receipt, and mileage is paid at the IRS rate." },
  ];
  for (const c of chats) await L.run(c);
  // Decided history in the Inbox, and the pending items for this week.
  const theo = "usr_theo";
  const decided: Parameters<Layer["proposal"]>[0][] = [
    { at: pt("2026-03-03", 9), command: "people.update_profile", args: { worker_id: "wrk_0031", preferred_name: "Tom" }, subjectRef: "wrk_0031", risk: "R1", headline: "Set the preferred name for Tomasz Nowak (demo) to Tom", domain: "people", status: "executed", decidedBy: "usr_sam", decidedAt: pt("2026-03-03", 11), reversible: true,
      exec: { ts: pt("2026-03-03", 11), actorKind: "human", actorId: "usr_sam", summary: "Set the preferred name of wrk_0031 to Tom", reversible: "yes", reverse: { command: "people.update_profile", args: { worker_id: "wrk_0031", preferred_name: null } } } },
    { at: pt("2026-05-11", 10), command: "it.order_device", args: { worker_id: "wrk_0018", sku: "standard_laptop" }, subjectRef: "wrk_0018", risk: "R2", headline: "Order a replacement laptop for Kofi Mensah (demo)", domain: "it", status: "denied", decidedBy: "usr_dana", decidedAt: pt("2026-05-11", 14), decisionCode: "not_needed", decisionNote: "Repair first; the screen is under warranty." },
    { at: pt("2026-07-30", 9), command: "comms.send_message", args: { channel: "#general", text: "Summer hours start Monday (demo)." }, subjectRef: "#general", risk: "R1", headline: "Post the summer hours note in #general", kind: "suggestion", domain: "comms", status: "dismissed", decidedBy: "usr_dana", decidedAt: pt("2026-07-30", 12) },
    { at: pt("2026-09-14", 9), command: "time_off.decide", args: { worker_id: "wrk_0014", decision: "approve" }, subjectRef: "wrk_0014", risk: "R1", headline: "Approve 2 days of vacation for Caleb Whitaker (demo)", domain: "people", status: "executed", decidedBy: theo, decidedAt: pt("2026-09-14", 13),
      exec: { ts: pt("2026-09-14", 13), actorKind: "human", actorId: theo, summary: "Approved vacation for wrk_0014", reversible: "no" } },
    { at: pt("2026-10-05", 9), command: "benefits.nudge_open_enrollment", args: { plan_year: 2027 }, subjectRef: "open_enrollment:2027", risk: "R1", headline: "Remind the employees who have not opened the 2027 enrollment", kind: "suggestion", domain: "benefits", status: "dismissed", decidedBy: "usr_sam", decidedAt: pt("2026-10-05", 10), decisionNote: "Waiting until the carrier rates are final." },
  ];
  const decidedIds: string[] = [];
  for (const d of decided) decidedIds.push(await L.proposal(d));
  // The rolled-back profile edit: the reversing row points at the edit above (its action key is the proposal id).
  L.action({ ts: pt("2026-03-03", 15), actorKind: "human", actorId: "usr_sam", command: "people.update_profile", args: { worker_id: "wrk_0031", preferred_name: null }, summary: "Rolled back the preferred name edit on wrk_0031 (entered on the wrong person)", reversible: "no", reverses: decidedIds[0] });
  // Pending suggestions in the Inbox for this week.
  const sug: Parameters<Layer["proposal"]>[0][] = [
    { at: pt("2026-10-26", 8, 5), command: "routines.enable", args: { routine_id: "rt_expense_review" }, subjectRef: "rt_expense_review", risk: "R1", headline: "Turn on the Expense review routine: 8 claims are waiting for a decision", kind: "suggestion", domain: "company", status: "pending", expiresAt: "2026-11-09T16:00:00.000Z",
      agentNote: "The routine checks each claim against the policy and drafts the decision for a person to approve." },
    { at: pt("2026-10-26", 8, 6), command: "benefits.nudge_open_enrollment", args: { plan_year: 2027 }, subjectRef: "open_enrollment:2027", risk: "R1", headline: "Nudge the open enrollment stragglers before the window closes", kind: "suggestion", domain: "benefits", status: "pending", expiresAt: "2026-11-09T16:00:00.000Z" },
    { at: pt("2026-10-26", 8, 7), command: "tax.register_state_account", args: { state: "CO" }, subjectRef: "CO", risk: "R2", headline: "Register Colorado withholding and unemployment accounts before Noor Castellanos (demo) starts on Nov 2", kind: "suggestion", domain: "tax", status: "pending", expiresAt: "2026-11-02T16:00:00.000Z",
      evidence: [{ label: "Offer", ref: "offr_0001" }] },
  ];
  for (const s of sug) await L.proposal(s);
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
  // Routines that ran in a September trial and are paused now, plus the October chases.
  const trial: [string, string, string, string, string | null][] = [
    ["rt_expense_review", pt("2026-09-14", 10), "Checked 6 claims against the policy: 5 within limits, 1 missing a receipt. Drafted the decisions for review.", "expenses__list", null],
    ["rt_expense_review", pt("2026-09-28", 10), "Checked 4 claims against the policy: all within limits. Drafted the approvals for review.", "expenses__list", null],
    ["rt_milestones", pt("2026-09-21", 9), "Posted 2 work anniversaries in #general.", "comms__send_message", "#general"],
    ["rt_milestones", pt("2026-10-05", 9), "Posted 1 work anniversary in #general.", "comms__send_message", "#general"],
    ["rt_open_enrollment", pt("2026-10-05", 10), "Sent the first open enrollment reminder to the employees who have not opened the 2027 window.", "comms__send_email", null],
    ["rt_onboarding_nudge", pt("2026-10-21", 9), "Reminded Mira Delgado (demo) to add a bank account; payroll is blocked until it is on file.", "comms__send_email", null],
  ];
  for (const [routineId, at, final, tool, channel] of trial) {
    const r = await L.run({ at, trigger: "routine", routineId, onBehalfOf: "usr_dana", final, tools: [{ name: tool, args: channel ? { channel } : {}, data: { ok: true } }] });
    if (channel) {
      const msg = await L.chat(channel, "Weft agent", final.replace(/^Posted /, "Celebrating today: ").replace(" in #general.", " (demo)."), at);
      L.action({ ts: at, actorKind: "routine", actorId: AGENT, onBehalfOf: "usr_dana", agentRunId: r.runId, routineRunId: r.routineRunId, command: "comms.send_message", args: { channel, text: final }, summary: `Posted to ${channel} (${msg})`, reversible: "no" });
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
        await L.tx.insert(timeOffLedger).values({ id: await newId(L.tx, "tol_"), assignmentId: a.id, workerId: w.id, policyId: a.policyId, kind: "use", minutes: -minutes,
          effectiveDate: start, sourceRef: id, note: "time off taken", createdAt: pt(start, 18) });
        usedBy.set(a.id, (usedBy.get(a.id) ?? 0) + minutes);
        L.bump("time_off_ledger");
      }
    }
    // The imported opening balance is net of usage; itemizing the usage adds the same minutes back as accrued, so
    // Available stays exactly what the base seed imported and caps still hold.
    for (const [assignmentId, minutes] of usedBy) {
      const a = mine.find((x) => x.id === assignmentId)!;
      await L.tx.insert(timeOffLedger).values({ id: await newId(L.tx, "tol_"), assignmentId, workerId: w.id, policyId: a.policyId, kind: "import", minutes,
        effectiveDate: "2026-10-15", note: "accrued before the usage itemized above, imported from the previous provider", createdAt: "2026-10-15T16:00:00.000Z" });
      L.bump("time_off_ledger");
    }
  }
  // Out today (Mon Oct 26): an approved CA sick day and a NY vacation day, outside the hardware team.
  for (const [wid, policy, reason] of [["wrk_0014", "top_sick_ca", "Sick day"], ["wrk_0028", "top_vac_us", "Long weekend"]] as const) {
    const w = ws.find((x) => x.id === wid);
    if (!w) continue;
    await L.tx.insert(timeOffRequests).values({ id: await newId(L.tx, "tor_"), companyId: CO, workerId: wid, policyId: policy, status: "approved", startAt: "2026-10-26", endAt: "2026-10-26",
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
      const body = `${DEMO_DOC}\n\n${title}\nLarkspur Robotics (demo)\n${name(w)}\nSigned ${signed.slice(0, 10)}.`;
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
  const done = await newId(tx, "ofb_");
  await tx.insert(offboardingCases).values({ id: done, companyId: CO, workerId: leaverId, kind: "voluntary", lastDay, reasonNote: "Relocating to be closer to family", status: "complete", createdAt: pt("2026-07-01", 10), closedAt: pt("2026-07-20", 12) });
  const stepsDone: [string, string][] = [
    ["final_pay", "Final pay included on the Jul 17 regular run, with accrued vacation paid out"], ["directory_suspend", "Suspended Google Workspace (sim) rafael.ostrander"],
    ["sso_deactivate", "Suspended SSO (sim) rafael.ostrander"], ["group_removal", "Removed 3 group memberships"], ["app_removal", "Removed Team chat (sim) rafael.ostrander"],
    ["device_lock", "Locked 1 device; returned to the Oakland office on Jul 20"], ["cobra_notice", "COBRA notice emailed to rafael.ostrander@mail.example"], ["benefits_terminate", "Terminated 3 enrollments, effective to 2026-07-31"],
  ];
  for (const [kind, detail] of stepsDone) {
    await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: done, kind, status: "done", detail, doneAt: pt(kind === "final_pay" ? lastDay : "2026-07-18", 10) });
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
      ["cobra_notice", "done", "COBRA notice prepared and sent ahead of the last day"], ["benefits_terminate", "pending", "Coverage ends 2026-11-30"],
    ];
    for (const [kind, status, detail] of plan) await tx.insert(offboardingSteps).values({ id: await newId(tx, "ofs_"), caseId: open, kind, status, detail, doneAt: status === "done" ? pt("2026-10-20", 11) : null });
    L.action({ ts: pt("2026-10-16", 15), actorKind: "human", actorId: "usr_sam", command: "offboarding.start", args: { worker_id: jonah.id, last_day: "2026-11-13" }, summary: `Started offboarding for ${name(jonah)} (${jonah.id}), last day 2026-11-13`, reversible: "no" });
  }
  L.bump("offboarding_cases", 2);
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
    let month = w.startDate.slice(0, 7);
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
    L = new Layer(tx);
    const ws = await tx.select().from(workers).orderBy(asc(workers.id));
    await seedAgentHistory(L, ws);
    await seedTimeOffHistory(L, ws);
    await seedPeopleRecords(L, ws);
    await seedMoneyAndCompliance(L, ws);
    const api: MotionApi = {
      tx, bump: (t, n) => L.bump(t, n), chat: (c, a, t, ts) => L.chat(c, a, t, ts),
      proposal: (p) => L.proposal(p as Parameters<Layer["proposal"]>[0]), run: (r) => L.run(r as unknown as RunSpec), action: (a) => L.action(a as unknown as PendingAction),
    };
    await seedRichMotion(api, ws);
    await seedTurnover({ tx, bump: (t, n) => L.bump(t, n), action: (a) => L.action(a as unknown as PendingAction) });
    await seedImportedPayHistory(tx, (t, n) => L.bump(t, n));
    tail = await L.flushActions();
  }));
  const commits = await seedMemory(ctx, tail);
  L.bump("memory_commits", commits);
  return L.counts;
}
