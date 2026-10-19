// time_off.* commands (wave 3, docs/wave3.md). Owner: w3-timeoff. Append WeftCommand definitions to this array; commands/index.ts
// concatenates it. Names, risk classes and access are fixed by W3_PLANNED_COMMANDS in packages/contracts/src/wave3.ts.
// Amounts are integer minutes from an append-only ledger (research/wave3/expenses-timeoff.md 6). The employee never
// types an amount: request minutes come from the dates and the holiday calendar. An agent's decide is always a
// proposal; a person's direct call runs it, and the manager check (direct reports only) lives inside run().
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { MINUTES_PER_DAY, type TimeOffRequest } from "@weft/contracts";
import { departments, paychecks, payrollRuns, principals, proposals, timeOffAssignments, timeOffLedger, timeOffRequests, workers, type DbTx } from "@weft/db";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { DomainRefusal, notFound, ptDateOf, readCommand, riskOf, writeCommand } from "../demo/define";
import { refreshOpenDrafts } from "../payroll/lifecycle";
import { applyCaps, deemedWorkedMinutes, forfeitureProblem, perHourWorked, postedBalance, requestDays, yearEndCarry } from "../time-off/engine";
import {
  appendLedger, assignmentsOf, balanceFor, checksForRequest, displayName, employedOn, ensureAssignments, holidayMap, ledgerOf, loadPolicies, parseDays, periodAccrual,
  policyById, routeRequest, teamCoverage, workerOf, type PolicyRow, type RequestRow,
} from "../time-off/store";
import { balanceForms, REQUEST_TOTALS_BY, requestBalance, requestTotals, timeForms, workerRef } from "../time-off/forms";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const h = (m: number) => `${(m / 60).toFixed(2)} h`;
const DECIDERS = new Set(["admin", "hr_manager"]);

export function requestDto(r: RequestRow): TimeOffRequest {
  return {
    id: r.id, workerId: r.workerId, policyId: r.policyId, status: r.status as TimeOffRequest["status"], startAt: r.startAt, endAt: r.endAt, rangeType: r.rangeType as "date",
    requestedMinutes: r.requestedMinutes, days: parseDays(r), reason: r.reason, approverPrincipalId: r.approverPrincipalId,
    routing: JSON.parse(r.routingJson) as TimeOffRequest["routing"], checks: JSON.parse(r.checksJson) as TimeOffRequest["checks"],
    decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionNote: r.decisionNote, payrollRunId: r.payrollRunId, createdAt: r.createdAt,
  };
}

async function requestOf(tx: DbTx, companyId: string, id: string): Promise<RequestRow> {
  const [r] = await tx.select().from(timeOffRequests).where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.companyId, companyId))).limit(1);
  if (!r) throw notFound("time-off request", id);
  return r;
}

const SOURCE_NAMES: Record<string, string> = { workday: "Workday" };
/** A request imported from a connected HR system (source other than weft) is read-only in Weft: it is decided,
 * cancelled and rerouted where it lives, and the next sync brings the change. */
function weftOwned(r: RequestRow): RequestRow {
  if (r.source === "weft") return r;
  const where = SOURCE_NAMES[r.source] ?? r.source;
  throw new DomainRefusal("DOMAIN_MANAGED_EXTERNALLY", `${r.id} is managed in ${where}; Weft shows it read-only`, `Change it in ${where}; the next sync updates Weft`, null);
}

const policySummary = (p: PolicyRow) => ({
  id: p.id, name: p.name, type: p.typeKind, type_name: p.typeName, paid: p.paid, jurisdiction: p.jurisdiction, schedule: p.schedule,
  minutes_per_period: p.minutesPerPeriod, tiers: JSON.parse(p.tiersJson) as unknown[], worked_minutes_per_chunk: p.workedMinutesPerChunk, minutes_per_chunk: p.minutesPerChunk,
  accrual_cap_minutes: p.accrualCapMinutes, annual_accrual_cap_minutes: p.annualAccrualCapMinutes, carryover_cap_minutes: p.carryoverCapMinutes,
  annual_use_cap_minutes: p.annualUseCapMinutes, front_load_minutes: p.frontLoadMinutes, waiting_days_before_use: p.waitingDaysBeforeUse,
  min_increment_minutes: p.minIncrementMinutes, pay_out_at_separation: p.payOutAtSeparation, effective_from: p.effectiveFrom,
  sources: JSON.parse(p.sourcesJson) as { label: string; url: string }[],
});

// ------------------------------------------------------------------ reads (R0)

const ListPoliciesInput = z.object({});
const listPolicies = readCommand({
  name: "time_off.list_policies", domain: "people",
  summary: "List time-off policies (vacation, sick, unpaid, prenatal) with their accrual rules, caps and sources, plus company holidays.",
  description: "List the company's time-off policies: type, jurisdiction, accrual schedule (per pay period, per hour worked, front load), caps, carryover, use cap, waiting period, minimum increment, payout at separation and the sources behind each rule. Also lists the holiday calendar. All amounts are minutes (480 is one day).",
  input: ListPoliciesInput,
  async run(_i, ctx, deps) {
    const pols = await loadPolicies(deps.tx, ctx.companyId);
    const hol = [...(await holidayMap(deps.tx, ctx.companyId)).entries()].sort().map(([d, name]) => ({ date: d, name }));
    return { data: { policies: pols.map(policySummary), holidays: hol }, summary: `${pols.length} policies and ${hol.length} holidays` };
  },
});

const BalanceInput = z.object({ worker_id: z.string().optional(), policy_id: z.string().optional(), as_of: date.optional(), include_ledger: z.boolean().optional() });
type BalanceInput = z.infer<typeof BalanceInput>;
const getBalance = readCommand<BalanceInput, Record<string, unknown>>({
  name: "time_off.get_balance", domain: "people",
  summary: "Read time-off balances per policy: unlocked, locked, used, holds and available, in minutes, hours and days.",
  description: "Read one worker's (or, without worker_id, every employee's) time-off balances as of a date (default today) for every assigned policy, or one policy_id, from the append-only ledger: accrued unlocked, accrued locked (waiting period), used, holds (pending and approved, not yet taken) and available, in minutes; available, used and holds also in hours and days. include_ledger adds the ledger rows.",
  input: BalanceInput,
  async run(i: BalanceInput, ctx, deps) {
    const asOf = i.as_of ?? ptDateOf(ctx.now);
    const pols = await loadPolicies(deps.tx, ctx.companyId);
    let ws: Awaited<ReturnType<typeof workerOf>>[];
    if (i.worker_id) {
      const w = await workerOf(deps.tx, ctx.companyId, i.worker_id);
      if (!w) throw notFound("worker", i.worker_id);
      ws = [w];
    } else {
      ws = (await deps.tx.select().from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.type, "employee")))).filter((w) => w.status !== "inactive").sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    const asns = await assignmentsOf(deps.tx, ws.map((w) => w!.id));
    const people = [];
    for (const w of ws) {
      if (!w) continue;
      const assigned = new Set(asns.filter((a) => a.workerId === w.id).map((a) => a.policyId));
      const balances = [];
      for (const p of pols.filter((x) => assigned.has(x.id) && (!i.policy_id || x.id === i.policy_id))) {
        const b = await balanceFor(deps.tx, w, p, asOf);
        const rows = i.include_ledger ? (await ledgerOf(deps.tx, w.id, p.id)).map((r) => ({ id: r.id, kind: r.kind, minutes: r.minutes, effective_date: r.effectiveDate, source_ref: r.sourceRef, note: r.note })) : undefined;
        balances.push({ ...b, policyName: p.name, typeName: p.typeName, available_display: h(b.availableMinutes), ...balanceForms(b), ...(rows ? { ledger: rows } : {}) });
      }
      people.push({ worker_id: w.id, name: displayName(w), department_id: w.departmentId, work_state: w.workState, balances });
    }
    if (i.worker_id) {
      const one = people[0]!;
      return { data: { worker_id: one.worker_id, name: one.name, as_of: asOf, balances: one.balances }, summary: `${one.name}: ${one.balances.map((b) => `${b.policyName} ${b.available_display}`).join(", ") || "no time-off policies"}` };
    }
    return { data: { as_of: asOf, count: people.length, workers: people }, summary: `Balances for ${people.length} employees as of ${asOf}` };
  },
});

const ListRequestsInput = z.object({
  request_id: z.string().optional(), status: z.enum(["pending", "approved", "denied", "cancelled", "taken"]).optional(), worker_id: z.string().optional(), department_id: z.string().optional(),
  approver: z.string().optional(), from: date.optional(), to: date.optional(), totals_by: z.array(z.enum(REQUEST_TOTALS_BY)).max(REQUEST_TOTALS_BY.length).optional(),
});
type ListRequestsInput = z.infer<typeof ListRequestsInput>;
export async function listRequestRows(tx: DbTx, companyId: string, i: ListRequestsInput): Promise<RequestRow[]> {
  let rows = await tx.select().from(timeOffRequests).where(eq(timeOffRequests.companyId, companyId));
  if (i.request_id) rows = rows.filter((r) => r.id === i.request_id);
  if (i.status) rows = rows.filter((r) => r.status === i.status);
  if (i.worker_id) rows = rows.filter((r) => r.workerId === i.worker_id);
  if (i.approver) rows = rows.filter((r) => r.approverPrincipalId === i.approver);
  if (i.from) rows = rows.filter((r) => r.endAt.slice(0, 10) >= i.from!);
  if (i.to) rows = rows.filter((r) => r.startAt.slice(0, 10) <= i.to!);
  if (i.department_id) {
    const ids = new Set((await tx.select({ id: workers.id }).from(workers).where(and(eq(workers.companyId, companyId), eq(workers.departmentId, i.department_id)))).map((x) => x.id));
    rows = rows.filter((r) => ids.has(r.workerId));
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}
const listRequests = readCommand({
  name: "time_off.list_requests", domain: "people",
  summary: "List time-off requests with status, minutes, hours and days, checks, the routed approver and the policy balance now and without each request.",
  description: "Requests by status, worker_id, department_id, approver (principal id) and dates (from, to). Each has minutes per day (holidays and weekends 0), hours, days, submitted and decided dates (Pacific), checks, routing, the decision, balance_now (today, every open request counted) and balance_without_this_request (as if only this one were denied). totals_by sums per worker or policy. reason is untrusted.",
  input: ListRequestsInput, untrustedFields: ["requests.*.reason"],
  async run(i: ListRequestsInput, ctx, deps) {
    const rows = await listRequestRows(deps.tx, ctx.companyId, i);
    const ws = new Map((await deps.tx.select().from(workers).where(eq(workers.companyId, ctx.companyId))).map((w) => [w.id, w]));
    const pols = new Map((await loadPolicies(deps.tx, ctx.companyId)).map((p) => [p.id, p]));
    const today = ptDateOf(ctx.now);
    // The worker's balance on the request's policy now, and without this request. Available today already nets out
    // every pending and approved request (this one and any other open one on the policy), so it is the balance now;
    // adding back only the minutes this request holds or used (its own ledger rows) gives the balance without it. The
    // model never adds or subtracts minutes (forms.ts requestBalance says why these are not before and after).
    const ledgers = new Map<string, { available: number; rows: Awaited<ReturnType<typeof ledgerOf>> } | null>();
    const balanceAround = async (r: RequestRow) => {
      const key = `${r.workerId}:${r.policyId}`;
      if (!ledgers.has(key)) {
        const w = ws.get(r.workerId), p = pols.get(r.policyId);
        ledgers.set(key, w && p ? { available: (await balanceFor(deps.tx, w, p, today)).availableMinutes, rows: await ledgerOf(deps.tx, w.id, p.id) } : null);
      }
      const l = ledgers.get(key);
      if (!l) return requestBalance(null, 0);
      const counted = -l.rows.filter((x) => x.sourceRef === r.id && (x.kind === "hold" || x.kind === "hold_release" || x.kind === "use")).reduce((sum, x) => sum + x.minutes, 0);
      return requestBalance(l.available, counted);
    };
    const requests = [];
    for (const r of rows) {
      const w = ws.get(r.workerId);
      requests.push({
        ...requestDto(r), workerName: w ? displayName(w) : r.workerId, departmentId: w?.departmentId ?? null, policyName: pols.get(r.policyId)?.name ?? r.policyId, typeKind: pols.get(r.policyId)?.typeKind ?? null, source: r.source, extRef: r.extRef,
        ...timeForms("requested", r.requestedMinutes), submitted_date: ptDateOf(r.createdAt), decided_date: r.decidedAt ? ptDateOf(r.decidedAt) : null, ...(await balanceAround(r)),
      });
    }
    const totals = requestTotals(rows, i.totals_by ?? [], (id) => (ws.get(id) ? workerRef(ws.get(id)!) : id), (id) => pols.get(id)?.name ?? id);
    return { data: { count: requests.length, ...totals, requests }, summary: `${requests.length} time-off requests` };
  },
});

const CalendarInput = z.object({ department_id: z.string(), from: date, to: date });
type CalendarInput = z.infer<typeof CalendarInput>;
const teamCalendar = readCommand({
  name: "time_off.team_calendar", domain: "people",
  summary: "A department's day-by-day time-off calendar: who is out, holidays and coverage percent.",
  description: "For department_id between from and to (at most 93 days): per day, who is out (approved and pending requests), the company holiday if any, the share of the department out and whether it is over the coverage limit (more than the department's max out percent, or fewer than its minimum present).",
  input: CalendarInput,
  async run(i: CalendarInput, ctx, deps) {
    const d = (await deps.tx.select().from(departments).where(and(eq(departments.id, i.department_id), eq(departments.companyId, ctx.companyId))).limit(1))[0];
    if (!d) throw notFound("department", i.department_id);
    if (i.to < i.from) throw new DomainRefusal("DOMAIN_BAD_RANGE", "to is before from", "Pass from on or before to", { department_id: i.department_id, from: i.from, to: i.from });
    const cov = await teamCoverage(deps.tx, ctx.companyId, d.id, i.from, i.to);
    const days = cov.days.map((x) => ({ date: x.date, out: x.out, holiday: x.holiday, outPct: x.outPct, overLimit: x.overLimit, headcount: x.headcount }));
    const over = days.filter((x) => x.overLimit).map((x) => x.date);
    return {
      data: { departmentId: d.id, departmentName: d.name, from: i.from, to: i.to, headcount: cov.headcount, maxOutPct: d.coverageMaxOutPct, minPresent: d.coverageMinPresent, days },
      summary: `${d.name}: ${over.length ? `over the coverage limit on ${over.join(", ")}` : "covered every day"}`,
    };
  },
});

// ------------------------------------------------------------------ deterministic checks and routing (R1)

const RequestIdInput = z.object({ request_id: z.string() });
type RequestIdInput = z.infer<typeof RequestIdInput>;

async function recheck(deps: CommandDeps, companyId: string, r: RequestRow, now: string) {
  const checks = await checksForRequest(deps.tx, companyId, r, ptDateOf(now));
  await deps.tx.update(timeOffRequests).set({ checksJson: JSON.stringify(checks) }).where(eq(timeOffRequests.id, r.id));
  return checks;
}

const checkRequest = writeCommand({
  name: "time_off.check_request", summary: "Run the deterministic checks on one time-off request and store them.",
  description: "Recompute the checks for request_id: insufficient projected balance, waiting period, annual use cap and minimum increment (block); coverage conflict and payroll deadline overlap (review); holidays inside the range and short notice (info). Idempotent; stores the result on the request.",
  input: RequestIdInput, domain: "people", needs: "view", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(i: RequestIdInput, ctx, deps) {
    const r = weftOwned(await requestOf(deps.tx, ctx.companyId, i.request_id));
    const checks = await recheck(deps, ctx.companyId, r, ctx.now);
    return { data: { request_id: r.id, checks }, summary: checks.length ? `${r.id}: ${checks.map((c) => `${c.rule} (${c.severity})`).join(", ")}` : `${r.id}: no checks fired` };
  },
});

const routeRequestCmd = writeCommand({
  name: "time_off.route_request", summary: "Route one time-off request to its approver (manager, then lead, then the People admin).",
  description: "Set the approver for request_id: the worker's manager when that manager is active and has a Weft login, else the department lead's login, else the People admin. Records each step and its reason.",
  input: RequestIdInput, domain: "people", needs: "view", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  async run(i: RequestIdInput, ctx, deps) {
    const r = weftOwned(await requestOf(deps.tx, ctx.companyId, i.request_id));
    const w = await workerOf(deps.tx, ctx.companyId, r.workerId);
    if (!w) throw notFound("worker", r.workerId);
    const route = await routeRequest(deps.tx, ctx.companyId, w);
    await deps.tx.update(timeOffRequests).set({ approverPrincipalId: route.approver, routingJson: JSON.stringify(route.chain) }).where(eq(timeOffRequests.id, r.id));
    return { data: { request_id: r.id, approver: route.approver, routing: route.chain }, summary: `${r.id} routed to ${route.approver}`, events: [{ type: "time_off.request.routed", subjectRef: r.id, payload: { request_id: r.id } }] };
  },
});

// ------------------------------------------------------------------ decide (R2, always a proposal for agents)

const DecideInput = z.object({ request_id: z.string(), decision: z.enum(["approve", "deny"]), note: z.string().max(400).optional() });
type DecideInput = z.infer<typeof DecideInput>;

/** The human whose decision this is: the approver of an approved proposal, or the direct caller. */
async function deciderOf(tx: DbTx, ctx: { principal: { id: string; kind: string }; approvedProposalId: string | null; companyId: string }) {
  let id: string | null = ctx.principal.kind === "human" ? ctx.principal.id : null;
  if (ctx.approvedProposalId) {
    const [p] = await tx.select({ decidedBy: proposals.decidedBy }).from(proposals).where(eq(proposals.id, ctx.approvedProposalId)).limit(1);
    id = p?.decidedBy ?? id;
  }
  if (!id) return null;
  const [row] = await tx.select().from(principals).where(and(eq(principals.id, id), eq(principals.companyId, ctx.companyId))).limit(1);
  return row ?? null;
}

async function decidePlan(tx: DbTx, companyId: string, i: DecideInput) {
  const r = weftOwned(await requestOf(tx, companyId, i.request_id));
  const w = await workerOf(tx, companyId, r.workerId);
  if (!w) throw notFound("worker", r.workerId);
  const p = await policyById(tx, companyId, r.policyId);
  if (!p) throw notFound("time-off policy", r.policyId);
  return { r, w, p };
}

const decide = writeCommand({
  name: "time_off.decide", summary: "Approve or deny one time-off request (an agent's call is always a proposal).",
  description: "Approve or deny request_id with a short note. Approval turns the hold into use rows per day; denial releases the hold. One request per call; there is no bulk decide. An agent's call is a proposal for the routed approver; managers decide only for their direct reports. Refused while a block check (balance, waiting period, use cap) stands.",
  input: DecideInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false,
  lease: (i: DecideInput) => `time_off:${i.request_id}`,
  errorHints: { INVALID_INPUT: { hint: "Pass one request_id and decision approve or deny", example: { request_id: "tor_0002", decision: "approve", note: "Coverage is fine with the holiday week" } } },
  async preview(i: DecideInput, ctx, deps) {
    const { r, w, p } = await decidePlan(deps.tx, ctx.companyId, i);
    const today = ptDateOf(ctx.now);
    const b = await balanceFor(deps.tx, w, p, today);
    const after = i.decision === "approve" ? b.availableMinutes : b.availableMinutes + r.requestedMinutes;
    const checks = JSON.parse(r.checksJson) as { rule: string; severity: string; message: string }[];
    return {
      title: `${i.decision === "approve" ? "Approve" : "Deny"} ${displayName(w)}'s ${p.typeName.toLowerCase()} ${r.startAt.slice(0, 10)} to ${r.endAt.slice(0, 10)} (${h(r.requestedMinutes)})`,
      diff: [
        { label: "Status", before: r.status, after: i.decision === "approve" ? "approved" : "denied" },
        { label: `${p.name} available`, before: h(b.availableMinutes), after: h(after) },
        ...checks.map((c) => ({ label: `Check ${c.rule} (${c.severity})`, before: "", after: c.message })),
      ],
      content: i.note ? [{ label: "Note", text: i.note }] : [], moneyCents: null,
      subjectRef: `time_off_request:${r.id}`,
      subjectHash: sha256Hex(canonicalJson({ id: r.id, status: r.status, minutes: r.requestedMinutes, days: r.daysJson, decision: i.decision })),
      evidence: [{ label: "request", ref: r.id }, { label: "worker", ref: w.id }],
    };
  },
  async run(i: DecideInput, ctx, deps) {
    const { r, w, p } = await decidePlan(deps.tx, ctx.companyId, i);
    if (r.status !== "pending") throw new DomainRefusal("DOMAIN_NOT_PENDING", `${r.id} is ${r.status}; only pending requests are decided`, "List pending requests with time_off.list_requests", null);
    const who = await deciderOf(deps.tx, ctx);
    if (!who || who.kind !== "human") throw new DomainRefusal("DOMAIN_NOT_APPROVER", "Only a person decides time off", "Propose the decision for the routed approver", null);
    if (who.workerId && who.workerId === w.id) throw new DomainRefusal("DOMAIN_SELF_APPROVAL", `${r.id} is ${who.display}'s own request; another approver decides it`, "Route it to the requester's manager, an HR manager or the People admin", null);
    if (who.role === "manager") {
      // A manager whose own worker record is no longer active (offboarding, inactive) has lost the approve right.
      const mine = who.workerId ? await workerOf(deps.tx, ctx.companyId, who.workerId) : null;
      if (!mine || mine.status !== "active") throw new DomainRefusal("DOMAIN_NOT_APPROVER", `${who.display} is no longer an active manager`, "The People admin decides while the team has no manager", null);
      if (!who.workerId || w.managerId !== who.workerId) throw new DomainRefusal("DOMAIN_NOT_DIRECT_REPORT", `${who.display} decides time off only for direct reports; ${displayName(w)} is not one`, "Route the request to the worker's own manager or the People admin", null);
    } else if (!DECIDERS.has(who.role ?? "")) {
      throw new DomainRefusal("DOMAIN_NOT_APPROVER", `${who.display} (${who.role ?? "no role"}) cannot decide time off`, "The manager, an HR manager or the People admin decides", null);
    }
    const days = parseDays(r);
    let checks = JSON.parse(r.checksJson) as { rule: string; severity: string }[];
    if (i.decision === "approve") {
      checks = await recheck(deps, ctx.companyId, r, ctx.now);
      const blocking = checks.filter((c) => c.severity === "block").map((c) => c.rule);
      if (blocking.length) throw new DomainRefusal("DOMAIN_REQUEST_BLOCKED", `${r.id} cannot be approved: ${blocking.join(", ")}`, "Deny it with a note, or wait until the block clears", { request_id: r.id, decision: "deny", note: blocking.join(", ") });
    }
    const asn = (await deps.tx.select().from(timeOffAssignments).where(and(eq(timeOffAssignments.workerId, w.id), eq(timeOffAssignments.policyId, p.id))).limit(1))[0];
    const assignmentId = asn?.id ?? "tasn_none";
    const holdRows = (await ledgerOf(deps.tx, w.id, p.id)).filter((x) => x.sourceRef === r.id && (x.kind === "hold" || x.kind === "hold_release"));
    const held = -holdRows.reduce((s, x) => s + x.minutes, 0);
    const base = { assignmentId, workerId: w.id, policyId: p.id, sourceRef: r.id, actionSeq: null, createdAt: ctx.now };
    if (held > 0) await appendLedger(deps.tx, deps.newId, { ...base, kind: "hold_release", minutes: held, effectiveDate: r.startAt.slice(0, 10), runKey: null, note: `released on ${i.decision}` });
    if (i.decision === "approve") {
      for (const d of days) if (d.minutes > 0) await appendLedger(deps.tx, deps.newId, { ...base, kind: "use", minutes: -d.minutes, effectiveDate: d.date, runKey: null, note: null });
    }
    const status = i.decision === "approve" ? "approved" : "denied";
    await deps.tx.update(timeOffRequests).set({ status, decidedBy: who.id, decidedAt: ctx.now, decisionNote: i.note ?? null }).where(eq(timeOffRequests.id, r.id));
    const refreshed = await refreshOpenDrafts(deps.tx, { newId: deps.newId, now: ctx.now }, ctx.companyId, r.startAt.slice(0, 10));   // leave lines, or the pending flag cleared
    return {
      data: { request_id: r.id, status, decided_by: who.id, minutes: r.requestedMinutes, refreshed_runs: refreshed },
      summary: `${status === "approved" ? "Approved" : "Denied"} ${displayName(w)}'s ${p.typeName.toLowerCase()} ${r.startAt.slice(0, 10)} to ${r.endAt.slice(0, 10)} (${h(r.requestedMinutes)})`,
      events: [{ type: "time_off.request.decided", subjectRef: r.id, payload: { request_id: r.id, status } }],
    };
  },
});

// ------------------------------------------------------------------ submit and cancel (human only)

const SubmitInput = z.object({
  worker_id: z.string(), policy_id: z.string(), start_date: date, end_date: date, partial_day_minutes: z.number().int().optional(), reason: z.string().max(400).optional(),
});
type SubmitInput = z.infer<typeof SubmitInput>;

async function mayActFor(tx: DbTx, companyId: string, principalId: string, role: string | null, workerId: string): Promise<boolean> {
  if (DECIDERS.has(role ?? "")) return true;
  const [p] = await tx.select().from(principals).where(and(eq(principals.id, principalId), eq(principals.companyId, companyId))).limit(1);
  return !!p && p.workerId === workerId;
}

export async function submitRequest(deps: CommandDeps, ctx: { companyId: string; now: string }, i: SubmitInput) {
  const tx = deps.tx;
  const w = await workerOf(tx, ctx.companyId, i.worker_id);
  if (!w || w.type !== "employee") throw notFound("employee", i.worker_id);
  const p = await policyById(tx, ctx.companyId, i.policy_id);
  if (!p) throw notFound("time-off policy", i.policy_id);
  await ensureAssignments(tx, deps.newId, w, ctx.now);   // a hire after the seed gets the policies of their state first
  const asn = (await assignmentsOf(tx, [w.id])).find((a) => a.policyId === p.id);
  if (!asn) throw new DomainRefusal("DOMAIN_NOT_ASSIGNED", `${displayName(w)} is not on ${p.name}`, "Use a policy from time_off.get_balance for this worker", null);
  if (i.end_date < i.start_date) throw new DomainRefusal("DOMAIN_BAD_RANGE", "end_date is before start_date", "Pass end_date on or after start_date", null);
  if (i.partial_day_minutes !== undefined && i.start_date !== i.end_date) throw new DomainRefusal("DOMAIN_BAD_RANGE", "A partial day is a one-day request", "Use the same start_date and end_date", null);
  if (i.partial_day_minutes !== undefined && (i.partial_day_minutes <= 0 || i.partial_day_minutes > MINUTES_PER_DAY)) throw new DomainRefusal("DOMAIN_BAD_RANGE", "partial_day_minutes is between 1 and 480", null, null);
  if (!employedOn(w, i.start_date) || (w.endDate !== null && w.endDate < i.end_date)) throw new DomainRefusal("DOMAIN_NOT_EMPLOYED", `${displayName(w)} is not employed for the whole range`, null, null);
  const hol = await holidayMap(tx, ctx.companyId);
  const { days, minutes } = requestDays(i.start_date, i.end_date, hol, i.partial_day_minutes ?? null);
  if (minutes === 0) throw new DomainRefusal("DOMAIN_NO_WORKING_DAYS", "The range has no working days (weekends and company holidays are 0)", "Pick dates that include a working day", null);
  const open = (await tx.select().from(timeOffRequests).where(and(eq(timeOffRequests.workerId, w.id), inArray(timeOffRequests.status, ["pending", "approved"]))));
  const clash = open.find((o) => o.startAt.slice(0, 10) <= i.end_date && o.endAt.slice(0, 10) >= i.start_date);
  if (clash) throw new DomainRefusal("DOMAIN_OVERLAPPING_REQUEST", `${displayName(w)} already has ${clash.id} (${clash.status}) on those dates`, "Cancel it first or pick other dates", null);
  const id = await deps.newId("tor_");
  const route = await routeRequest(tx, ctx.companyId, w);
  await tx.insert(timeOffRequests).values({
    id, companyId: ctx.companyId, workerId: w.id, policyId: p.id, status: "pending", startAt: i.start_date, endAt: i.end_date, rangeType: "date", timeZone: w.timezone,
    requestedMinutes: minutes, daysJson: JSON.stringify(days), reason: i.reason ?? "", approverPrincipalId: route.approver, routingJson: JSON.stringify(route.chain),
    checksJson: "[]", decidedBy: null, decidedAt: null, decisionNote: null, payrollRunId: null, actionSeq: null, source: "weft", extRef: null, createdAt: ctx.now,
  });
  await appendLedger(tx, deps.newId, { assignmentId: asn.id, workerId: w.id, policyId: p.id, kind: "hold", minutes: -minutes, effectiveDate: i.start_date, sourceRef: id, runKey: null, note: null, actionSeq: null, createdAt: ctx.now });
  const row = (await tx.select().from(timeOffRequests).where(eq(timeOffRequests.id, id)).limit(1))[0]!;
  const checks = await checksForRequest(tx, ctx.companyId, row, ptDateOf(ctx.now));
  await tx.update(timeOffRequests).set({ checksJson: JSON.stringify(checks) }).where(eq(timeOffRequests.id, id));
  // An open draft that pays these days gets its PENDING_TIME_OFF_IN_PERIOD flag now, not at the next recompute.
  await refreshOpenDrafts(tx, { newId: deps.newId, now: ctx.now }, ctx.companyId, i.start_date);
  return { id, w, p, minutes, days, checks, approver: route.approver };
}

const submit = writeCommand({
  name: "time_off.submit", summary: "Request time off for a worker; minutes come from the dates and the holiday calendar.",
  description: "Submit a time-off request for worker_id on policy_id from start_date to end_date (one day may be partial). Minutes are computed from the dates: weekends and company holidays are 0. Creates a hold on the balance, runs the checks and routes the request to its approver.",
  input: SubmitInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "never", reversible: false, preview: null, access: "human_only",
  async run(i: SubmitInput, ctx, deps) {
    if (!(await mayActFor(deps.tx, ctx.companyId, ctx.principal.id, ctx.principal.role, i.worker_id))) throw new DomainRefusal("DOMAIN_NOT_PERMITTED", "You can request time off only for yourself", null, null);
    const s = await submitRequest(deps, ctx, i);
    return {
      data: { request_id: s.id, status: "pending", requested_minutes: s.minutes, days: s.days, checks: s.checks, approver: s.approver },
      summary: `Requested ${h(s.minutes)} of ${s.p.typeName.toLowerCase()} for ${displayName(s.w)} (${i.start_date} to ${i.end_date}); routed to ${s.approver}`,
      events: [{ type: "time_off.request.created", subjectRef: s.id, payload: { request_id: s.id, worker_id: s.w.id } }, { type: "time_off.request.routed", subjectRef: s.id, payload: { request_id: s.id } }],
    };
  },
});

const cancel = writeCommand({
  name: "time_off.cancel", summary: "Cancel a pending, or an approved but not yet started, time-off request.",
  description: "Cancel request_id. A pending request releases its hold; an approved request that has not started returns its use rows to the balance.",
  input: RequestIdInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "never", reversible: false, preview: null, access: "human_only",
  async run(i: RequestIdInput, ctx, deps) {
    const r = weftOwned(await requestOf(deps.tx, ctx.companyId, i.request_id));
    if (!(await mayActFor(deps.tx, ctx.companyId, ctx.principal.id, ctx.principal.role, r.workerId))) throw new DomainRefusal("DOMAIN_NOT_PERMITTED", "You can cancel only your own requests", null, null);
    const today = ptDateOf(ctx.now);
    if (r.status !== "pending" && !(r.status === "approved" && r.startAt.slice(0, 10) > today)) throw new DomainRefusal("DOMAIN_NOT_CANCELLABLE", `${r.id} is ${r.status}${r.status === "approved" ? " and has started" : ""}`, null, null);
    const rows = (await ledgerOf(deps.tx, r.workerId, r.policyId)).filter((x) => x.sourceRef === r.id);
    const net = rows.reduce((s, x) => s + x.minutes, 0);
    const base = { assignmentId: rows[0]?.assignmentId ?? "tasn_none", workerId: r.workerId, policyId: r.policyId, sourceRef: r.id, runKey: null, actionSeq: null, createdAt: ctx.now };
    const held = -rows.filter((x) => x.kind === "hold" || x.kind === "hold_release").reduce((s, x) => s + x.minutes, 0);
    if (held > 0) await appendLedger(deps.tx, deps.newId, { ...base, kind: "hold_release", minutes: held, effectiveDate: r.startAt.slice(0, 10), note: "cancelled" });
    for (const u of rows.filter((x) => x.kind === "use")) await appendLedger(deps.tx, deps.newId, { ...base, kind: "use", minutes: -u.minutes, effectiveDate: u.effectiveDate, note: "cancelled" });
    await deps.tx.update(timeOffRequests).set({ status: "cancelled" }).where(eq(timeOffRequests.id, r.id));
    await refreshOpenDrafts(deps.tx, { newId: deps.newId, now: ctx.now }, ctx.companyId, r.startAt.slice(0, 10));   // leave lines or the pending flag go away
    return { data: { request_id: r.id, status: "cancelled", returned_minutes: -net }, summary: `Cancelled ${r.id}`, events: [{ type: "time_off.request.cancelled", subjectRef: r.id, payload: { request_id: r.id } }] };
  },
});

// ------------------------------------------------------------------ adjust and reopen

const AdjustInput = z.object({ worker_id: z.string(), policy_id: z.string(), minutes: z.number().int(), reason: z.string().min(1).max(400) });
type AdjustInput = z.infer<typeof AdjustInput>;
async function adjustPlan(tx: DbTx, ctx: { companyId: string; now: string }, i: AdjustInput) {
  const w = await workerOf(tx, ctx.companyId, i.worker_id);
  if (!w) throw notFound("worker", i.worker_id);
  const p = await policyById(tx, ctx.companyId, i.policy_id);
  if (!p) throw notFound("time-off policy", i.policy_id);
  const asn = (await assignmentsOf(tx, [w.id])).find((a) => a.policyId === p.id);
  if (!asn) throw new DomainRefusal("DOMAIN_NOT_ASSIGNED", `${displayName(w)} is not on ${p.name}`, "Use a policy from time_off.get_balance for this worker", null);
  if (i.minutes === 0) throw new DomainRefusal("DOMAIN_ZERO_ADJUSTMENT", "minutes must not be 0", null, null);
  const b = await balanceFor(tx, w, p, ptDateOf(ctx.now));
  if (b.availableMinutes + i.minutes < 0) throw new DomainRefusal("DOMAIN_NEGATIVE_BALANCE", `${displayName(w)} has ${h(b.availableMinutes)} available; Weft never takes a balance below zero`, "Adjust by at most the available balance", { worker_id: w.id, policy_id: p.id, minutes: -b.availableMinutes, reason: i.reason });
  return { w, p, asn, b };
}
const adjustBalance = writeCommand({
  name: "time_off.adjust_balance", summary: "Correct a worker's time-off balance by a signed number of minutes (always a proposal for agents).",
  description: "Post a signed adjustment of minutes to worker_id's balance on policy_id with a reason (for example a balance imported wrong). Never takes the available balance below zero. An agent's call is a proposal; the inverse adjustment reverses it.",
  input: AdjustInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", reversible: { reverse: "time_off.adjust_balance" },
  lease: (i: AdjustInput) => `time_off_balance:${i.worker_id}:${i.policy_id}`,
  async preview(i: AdjustInput, ctx, deps) {
    const { w, p, b } = await adjustPlan(deps.tx, ctx, i);
    return {
      title: `Adjust ${displayName(w)}'s ${p.name} by ${i.minutes > 0 ? "+" : ""}${h(i.minutes)}`,
      diff: [{ label: `${p.name} available`, before: h(b.availableMinutes), after: h(b.availableMinutes + i.minutes) }],
      content: [{ label: "Reason", text: i.reason }], moneyCents: null, subjectRef: `time_off_balance:${w.id}:${p.id}`,
      subjectHash: sha256Hex(canonicalJson({ w: w.id, p: p.id, available: b.availableMinutes, minutes: i.minutes })), evidence: [{ label: "worker", ref: w.id }],
    };
  },
  async run(i: AdjustInput, ctx, deps) {
    const { w, p, asn, b } = await adjustPlan(deps.tx, ctx, i);
    const id = await appendLedger(deps.tx, deps.newId, { assignmentId: asn.id, workerId: w.id, policyId: p.id, kind: "adjustment", minutes: i.minutes, effectiveDate: ptDateOf(ctx.now), sourceRef: null, runKey: null, note: i.reason.slice(0, 200), actionSeq: null, createdAt: ctx.now });
    return {
      data: { ledger_id: id, worker_id: w.id, policy_id: p.id, minutes: i.minutes, available_before: b.availableMinutes, available_after: b.availableMinutes + i.minutes },
      summary: `Adjusted ${displayName(w)}'s ${p.name} by ${h(i.minutes)} (now ${h(b.availableMinutes + i.minutes)})`,
      reverseArgs: { worker_id: w.id, policy_id: p.id, minutes: -i.minutes, reason: `Reverses: ${i.reason}`.slice(0, 400) },
      events: [{ type: "time_off.balance.adjusted", subjectRef: w.id, payload: { worker_id: w.id, policy_id: p.id } }],
    };
  },
});

const reopen = writeCommand({
  name: "time_off.reopen", summary: "Return a decided time-off request that has not started to pending.",
  description: "Reopen request_id: an approved request that has not started gets its use rows returned and its hold back; a denied one gets its hold back. The checks run again and the request waits for its approver.",
  input: RequestIdInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R2"), approval: "never", reversible: false, preview: null, access: "human_only",
  async run(i: RequestIdInput, ctx, deps) {
    const r = weftOwned(await requestOf(deps.tx, ctx.companyId, i.request_id));
    if (!DECIDERS.has(ctx.principal.role ?? "") && ctx.principal.role !== "manager") throw new DomainRefusal("DOMAIN_NOT_APPROVER", "Only an approver reopens a decided request", null, null);
    if (ctx.principal.role === "manager") {
      // Same reach as time_off.decide: a manager reopens only a direct report's request.
      const who = await deciderOf(deps.tx, ctx);
      const subject = await workerOf(deps.tx, ctx.companyId, r.workerId);
      if (!who?.workerId || subject?.managerId !== who.workerId) throw new DomainRefusal("DOMAIN_NOT_DIRECT_REPORT", "A manager reopens time off only for direct reports", "The worker's own manager or the People admin reopens it", null);
    }
    const today = ptDateOf(ctx.now);
    if (!(r.status === "approved" || r.status === "denied") || r.startAt.slice(0, 10) <= today) throw new DomainRefusal("DOMAIN_NOT_REOPENABLE", `${r.id} is ${r.status}${r.startAt.slice(0, 10) <= today ? " and has started" : ""}`, null, null);
    const rows = (await ledgerOf(deps.tx, r.workerId, r.policyId)).filter((x) => x.sourceRef === r.id);
    const base = { assignmentId: rows[0]?.assignmentId ?? "tasn_none", workerId: r.workerId, policyId: r.policyId, sourceRef: r.id, runKey: null, actionSeq: null, createdAt: ctx.now };
    for (const u of rows.filter((x) => x.kind === "use")) await appendLedger(deps.tx, deps.newId, { ...base, kind: "use", minutes: -u.minutes, effectiveDate: u.effectiveDate, note: "reopened" });
    await appendLedger(deps.tx, deps.newId, { ...base, kind: "hold", minutes: -r.requestedMinutes, effectiveDate: r.startAt.slice(0, 10), note: "reopened" });
    await deps.tx.update(timeOffRequests).set({ status: "pending", decidedBy: null, decidedAt: null, decisionNote: null }).where(eq(timeOffRequests.id, r.id));
    const fresh = (await deps.tx.select().from(timeOffRequests).where(eq(timeOffRequests.id, r.id)).limit(1))[0]!;
    await recheck(deps, ctx.companyId, fresh, ctx.now);
    await refreshOpenDrafts(deps.tx, { newId: deps.newId, now: ctx.now }, ctx.companyId, r.startAt.slice(0, 10));
    return { data: { request_id: r.id, status: "pending" }, summary: `Reopened ${r.id}` };
  },
});

// ------------------------------------------------------------------ system: accruals, payouts, year end

const RunInput = z.object({ run_id: z.string() });
type RunInput = z.infer<typeof RunInput>;

/** Posts one accrual per (run, assignment) for a processed regular run. Idempotent on the ledger's run_key. */
export async function postAccruals(deps: CommandDeps, companyId: string, runId: string, now: string): Promise<{ posted: number; capped: number; skipped: number }> {
  const tx = deps.tx;
  const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId))).limit(1);
  if (!run) throw notFound("payroll run", runId);
  const out = { posted: 0, capped: 0, skipped: 0 };
  if (run.subtype !== "regular" || run.status !== "processed") return out;
  const pcs = await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id));
  const ws = new Map((await tx.select().from(workers).where(eq(workers.companyId, companyId))).map((w) => [w.id, w]));
  const pols = new Map((await loadPolicies(tx, companyId)).map((p) => [p.id, p]));
  const period = { periodStart: run.periodStart, periodEnd: run.periodEnd };
  const year = run.periodEnd.slice(0, 4);
  for (const pc of pcs.sort((a, b) => (a.workerId < b.workerId ? -1 : 1))) {
    const w = ws.get(pc.workerId);
    if (!w) continue;
    await ensureAssignments(tx, deps.newId, w, now);
    for (const a of await assignmentsOf(tx, [w.id])) {
      const p = pols.get(a.policyId);
      if (!p || a.effectiveFrom > run.periodEnd || (a.effectiveTo !== null && a.effectiveTo < run.periodStart)) continue;
      if (p.schedule !== "per_pay_period" && p.schedule !== "per_hour_worked") continue;
      const runKey = `${run.id}:${a.id}`;
      const rows = await ledgerOf(tx, w.id, p.id);
      if (rows.some((x) => x.runKey === runKey) || rows.some((x) => x.kind === "import" && x.effectiveDate >= run.periodEnd)) { out.skipped++; continue; }
      let accrual = 0;
      let remainder = a.accrualRemainderMinutes;
      if (p.schedule === "per_pay_period") {
        if (!employedOn(w, run.periodEnd)) { out.skipped++; continue; }
        accrual = periodAccrual(p, w, run.periodEnd);
      } else {
        const worked = pc.hoursX100 !== null ? Math.round((pc.hoursX100 * 60) / 100) : deemedWorkedMinutes(period, w.startDate, w.endDate, p.exemptDeemedMinutesPerWeek ?? undefined);
        const r = perHourWorked(a.accrualRemainderMinutes, worked, p.workedMinutesPerChunk ?? 30, p.minutesPerChunk ?? 1);
        accrual = r.minutes; remainder = r.remainder;
      }
      const balance = postedBalance(rows, run.periodEnd);
      const accruedThisYear = rows.filter((x) => (x.kind === "accrual" || x.kind === "front_load") && x.effectiveDate.startsWith(year)).reduce((s, x) => s + x.minutes, 0);
      const c = applyCaps(accrual, { balance, cap: p.accrualCapMinutes, accruedThisYear, annualCap: p.annualAccrualCapMinutes });
      const base = { assignmentId: a.id, workerId: w.id, policyId: p.id, effectiveDate: run.periodEnd, sourceRef: run.id, actionSeq: null, createdAt: now };
      await appendLedger(tx, deps.newId, { ...base, kind: "accrual", minutes: c.posted, runKey, note: `${run.periodStart} to ${run.periodEnd}` });
      out.posted++;
      if (c.capped > 0) {
        await appendLedger(tx, deps.newId, { ...base, kind: "accrual_capped", minutes: 0, runKey: `${runKey}:capped`, note: `capped: ${c.capped} minutes not accrued (cap ${h(p.accrualCapMinutes ?? p.annualAccrualCapMinutes ?? 0)})` });
        out.capped++;
      }
      if (remainder !== a.accrualRemainderMinutes) await tx.update(timeOffAssignments).set({ accrualRemainderMinutes: remainder }).where(eq(timeOffAssignments.id, a.id));
    }
  }
  return out;
}

const postAccrualsCmd = writeCommand({
  name: "time_off.post_accruals", summary: "Post time-off accruals for a processed regular payroll run (system).",
  description: "System record: for each paycheck of the processed regular run run_id, post one accrual per assigned policy (per pay period by service tier, or per hour worked), applying the balance and annual caps. Idempotent per run and assignment; dismissal and off-cycle runs never accrue.",
  input: RunInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null, access: "system_only",
  async run(i: RunInput, ctx, deps) {
    const r = await postAccruals(deps, ctx.companyId, i.run_id, ctx.now);
    return { data: { run_id: i.run_id, ...r }, summary: `Accruals for ${i.run_id}: ${r.posted} posted, ${r.capped} capped, ${r.skipped} skipped` };
  },
});

/** For a processed dismissal run: the prorated final accrual and a payout row that zero the vacation balance. */
export async function recordPayouts(deps: CommandDeps, companyId: string, runId: string, now: string): Promise<number> {
  const tx = deps.tx;
  const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId))).limit(1);
  if (!run || run.subtype !== "dismissal" || run.status !== "processed") return 0;
  let n = 0;
  for (const pc of await tx.select().from(paychecks).where(eq(paychecks.payrollRunId, run.id))) {
    const line = (JSON.parse(pc.earningsJson) as { type: string; hoursX100: number | null }[]).find((e) => e.type === "pto_payout");
    if (!line?.hoursX100) continue;
    const w = await workerOf(tx, companyId, pc.workerId);
    if (!w) continue;
    const pols = (await loadPolicies(tx, companyId)).filter((p) => p.countsAsVacation && p.payOutAtSeparation);
    const a = (await assignmentsOf(tx, [w.id])).find((x) => pols.some((p) => p.id === x.policyId));
    if (!a) continue;
    const lastDay = w.endDate ?? run.periodEnd;
    const paid = Math.round((line.hoursX100 * 60) / 100);
    const posted = postedBalance(await ledgerOf(tx, w.id, a.policyId), lastDay);
    const base = { assignmentId: a.id, workerId: w.id, policyId: a.policyId, effectiveDate: lastDay, sourceRef: run.id, actionSeq: null, createdAt: now };
    if (paid > posted) await appendLedger(tx, deps.newId, { ...base, kind: "accrual", minutes: paid - posted, runKey: `${run.id}:${a.id}:final`, note: `final period prorated through ${lastDay}` });
    if (await appendLedger(tx, deps.newId, { ...base, kind: "payout", minutes: -paid, runKey: `${run.id}:${a.id}:payout`, note: `paid in final pay ${run.id}` })) n++;
  }
  return n;
}

const recordPayoutCmd = writeCommand({
  name: "time_off.record_payout", summary: "Record the vacation payout of a processed final pay run in the time-off ledger (system).",
  description: "System record: for the processed dismissal run run_id, post the prorated final accrual and a payout row so the paid-out vacation balance is zero. Idempotent.",
  input: RunInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null, access: "system_only",
  async run(i: RunInput, ctx, deps) {
    const n = await recordPayouts(deps, ctx.companyId, i.run_id, ctx.now);
    return { data: { run_id: i.run_id, payouts: n }, summary: `${n} vacation payouts recorded for ${i.run_id}` };
  },
});

const CloseYearInput = z.object({ year: z.number().int() });
type CloseYearInput = z.infer<typeof CloseYearInput>;
/** Year end: carry each balance up to its policy's carryover cap and forfeit the rest; front-load annual banks. */
export async function closeYear(deps: CommandDeps, companyId: string, year: number, now: string): Promise<{ forfeits: number; frontLoads: number }> {
  const tx = deps.tx;
  const pols = new Map((await loadPolicies(tx, companyId)).map((p) => [p.id, p]));
  const ws = new Map((await tx.select().from(workers).where(eq(workers.companyId, companyId))).map((w) => [w.id, w]));
  const all = (await tx.select().from(timeOffAssignments)).filter((a) => ws.has(a.workerId)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const dec31 = `${year}-12-31`, jan1 = `${year + 1}-01-01`;
  const out = { forfeits: 0, frontLoads: 0 };
  for (const a of all) {
    const p = pols.get(a.policyId), w = ws.get(a.workerId)!;
    if (!p || !employedOn(w, dec31)) continue;
    const rows = await ledgerOf(tx, w.id, p.id);
    const cap = p.schedule === "front_load_annual" ? 0 : p.carryoverCapMinutes;
    const { forfeit } = yearEndCarry(postedBalance(rows, dec31), cap);
    const base = { assignmentId: a.id, workerId: w.id, policyId: p.id, sourceRef: null, actionSeq: null, createdAt: now };
    if (forfeit > 0 && (await appendLedger(tx, deps.newId, { ...base, kind: "carryover_forfeit", minutes: -forfeit, effectiveDate: dec31, runKey: `close:${year}:${a.id}`, note: `over the ${h(cap ?? 0)} carryover cap` }))) out.forfeits++;
    if (p.schedule === "front_load_annual" && p.frontLoadMinutes && (p.effectiveTo === null || p.effectiveTo >= jan1)) {
      if (await appendLedger(tx, deps.newId, { ...base, kind: "front_load", minutes: p.frontLoadMinutes, effectiveDate: jan1, runKey: `front:${year + 1}:${a.id}`, note: `front load for ${year + 1}` })) out.frontLoads++;
    }
  }
  return out;
}

const closeYearCmd = writeCommand({
  name: "time_off.close_year", summary: "Close a time-off year: carryover caps, forfeits and next year's front loads (system).",
  description: "System record on the first scheduler tick of a new year: for each assignment, carry the balance up to the policy's carryover cap and post the rest as a forfeit (vacation in CA and CO never forfeits), then post the next year's front loads. Idempotent per year and assignment.",
  input: CloseYearInput, domain: "people", needs: "view", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null, access: "system_only",
  async run(i: CloseYearInput, ctx, deps) {
    const r = await closeYear(deps, ctx.companyId, i.year, ctx.now);
    return { data: { year: i.year, ...r }, summary: `Closed ${i.year}: ${r.forfeits} forfeits, ${r.frontLoads} front loads` };
  },
});

/** Policy validation used by the settings screens and the seed: CA and CO vacation never forfeits. */
export function validatePolicy(p: Parameters<typeof forfeitureProblem>[0]): void {
  const problem = forfeitureProblem(p);
  if (problem) throw new DomainRefusal("DOMAIN_FORFEITURE_NOT_ALLOWED", problem, "Set the carryover cap at or above the accrual cap, or leave it empty", null);
}

export const timeOffCommands: WeftCommand[] = [
  listPolicies, getBalance, listRequests, teamCalendar, checkRequest, routeRequestCmd, decide, adjustBalance, submit, cancel, reopen, postAccrualsCmd, recordPayoutCmd, closeYearCmd,
];
