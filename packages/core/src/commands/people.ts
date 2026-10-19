// people.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { and, asc, desc, eq, gte, like, lte, or } from "drizzle-orm";
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import { departments, offboardingCases, workers, type DbTx } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { isDetailed, notFound, ptDateOf, readCommand, responseFormatField } from "../demo/define";
import { nameRef } from "../people/names";
import { acceptOffer, revertPayRate, setPayRate, updateProfile } from "../people/writes";
import { bankSummary, currentPayRate, getWorker, homeAddressText, lookups, payRateHistory, taxProfile, workerWhere } from "../people/queries";
import { listTasks } from "../onboarding/queries";
import { DIRECTORY_FIELDS, directoryAccess, inScope, readScopeOf, type ReadScope } from "../people/scope";
import { caseDto, STEP_LABEL } from "../offboarding/cases";
import { taskLabel } from "./onboarding";

const WorkerStatus = z.enum(["draft", "invited", "onboarding", "active", "offboarding", "inactive"]);
const State = z.enum(["CA", "NY", "TX", "CO"]);

/** Query words for people.search: split on spaces, parentheses and commas, without the "(demo)" name suffix. */
export function searchWords(q: string | undefined): string[] {
  return (q ?? "").split(/[\s(),]+/).filter((w) => w && w.toLowerCase() !== "demo");
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** people.search returns at most this many workers; a larger limit is clamped and the result says so. */
export const SEARCH_MAX = 50;

const SearchInput = z.object({
  query: z.string().max(100).optional(),
  state: State.optional(),
  status: WorkerStatus.optional(),
  department_id: z.string().optional(),
  start_from: date.optional(),
  start_to: date.optional(),
  limit: z.number().int().optional(),
  ...responseFormatField,
});
type SearchInput = z.infer<typeof SearchInput>;

/**
 * A narrowed search shows a worker outside the viewer's reports only when the match rests on directory fields alone:
 * no status or start date filter, and every query word in the name, title or worker id (never the employee number).
 */
function directoryMatch(w: typeof workers.$inferSelect, i: SearchInput, words: string[]): boolean {
  if (i.status || i.start_from || i.start_to) return false;
  const hay = [w.firstName, w.lastName, w.title ?? ""].map((x) => x.toLowerCase());
  return words.every((q) => w.id === q || hay.some((h) => h.includes(q.toLowerCase())));
}

/** Words a department question wraps around the name ("the Hardware team", "people in Hardware"). */
const DEPARTMENT_FILLER = new Set(["the", "in", "department", "dept", "team", "people", "staff", "everyone", "all"]);

/**
 * The department a query names, if it names one and nothing else: "Hardware", "hardware team", "people in Hardware".
 * A department question then lists the department instead of the names and titles that contain the word.
 */
export function departmentNamed<D extends { id: string; name: string }>(words: string[], depts: D[]): D | null {
  const core = words.map((w) => w.toLowerCase()).filter((w) => !DEPARTMENT_FILLER.has(w)).join(" ");
  if (!core) return null;
  return depts.find((d) => d.name.toLowerCase() === core) ?? null;
}

function searchAccess(scope: ReadScope, i: SearchInput, narrowed: boolean) {
  const filtered = !!(i.status || i.start_from || i.start_to);
  return {
    scope: "reports" as const, full_records: `${scope.display}'s own record and their ${scope.reports.size} direct and indirect reports`,
    others: `directory fields only (${DIRECTORY_FIELDS.join(", ")}), marked directory_only`,
    withheld_for_others: ["status", "start date", "employee number", "pay", "bank account", "W-4", "benefits elections", "ID numbers"],
    ...(filtered && narrowed ? { filter_note: "Status and start date filters cover only these reports; workers outside them are not listed" } : {}),
  };
}

const peopleSearch = readCommand({
  name: "people.search", domain: "people",
  summary: "Search workers by name, state, status, department or start date window.",
  description: "Search workers by name or title (query), state, status, department_id or start date (start_from, start_to, YYYY-MM-DD). A query that is only a department name lists it (total = headcount). Returns ids, title, department, state, status, start date; counts by state, department, status. limit 1 to 50. Detailed adds employee number, manager, end date. Beyond a manager's reports: directory only.",
  input: SearchInput,
  async run(i: SearchInput, ctx, deps) {
    const tx = deps.tx;
    const q = i.query?.trim();
    const deptRows = await tx.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.companyId, ctx.companyId));
    // "How many people work in Hardware?" sends query "Hardware": a query that names a department (and nothing else)
    // lists that department, so total is its headcount and not the few names and titles that contain the word.
    const named = i.department_id ? null : departmentNamed(searchWords(q), deptRows);
    const departmentId = i.department_id ?? named?.id;
    const base = workerWhere(ctx.companyId, { state: i.state, status: i.status, departmentId });
    const where = and(base, ...(i.start_from ? [gte(workers.startDate, i.start_from)] : []), ...(i.start_to ? [lte(workers.startDate, i.start_to)] : []))!;
    // Every word must match a name, title or employee number, so a full name ("Hollis Grey") or the readable name with
    // its fictional-data suffix ("Hollis Grey (demo)") finds the worker; a single word behaves as before.
    const words = named ? [] : searchWords(q);
    const filtered = words.length ? and(where, ...words.map((w) => or(like(workers.firstName, `%${w}%`), like(workers.lastName, `%${w}%`), like(workers.title, `%${w}%`), like(workers.employeeNumber, `%${w}%`), like(workers.id, w)))) : where;
    const matched = await tx.select().from(workers).where(filtered).orderBy(asc(workers.id));
    const scope = await readScopeOf(tx, ctx);
    const rows = scope ? matched.filter((w) => inScope(scope, w.id) || directoryMatch(w, i, words)) : matched;
    const limit = Math.min(Math.max(i.limit ?? 20, 1), SEARCH_MAX);
    const L = await lookups(tx, ctx.companyId);
    const detailed = isDetailed(i);
    const list = rows.slice(0, limit).map((w) => (inScope(scope, w.id) ? {
      id: w.id, name: nameRef(w.firstName, w.lastName, w.id), title: w.title, department: L.dept(w.departmentId), work_state: w.workState, status: w.status, start_date: w.startDate,
      ...(detailed ? { employee_number: w.employeeNumber, type: w.type, manager: L.person(w.managerId), workplace: L.place(w.workplaceId), end_date: w.endDate } : {}),
    } : { id: w.id, name: nameRef(w.firstName, w.lastName, w.id), title: w.title, department: L.dept(w.departmentId), work_state: w.workState, manager: L.person(w.managerId), directory_only: true }));
    const byState: Record<string, number> = {};
    for (const w of rows) if (w.workState) byState[w.workState] = (byState[w.workState] ?? 0) + 1;
    // By department with ids, so a department filter (or a department-scoped read) can follow without guessing an id.
    const depts = new Map<string, number>();
    for (const w of rows) if (w.departmentId) depts.set(w.departmentId, (depts.get(w.departmentId) ?? 0) + 1);
    const byDepartment = [...depts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, n]) => ({ department_id: id, department: L.dept(id), count: n }));
    // By status for the rows a full record shows (a department's headcount reads "11: 9 active, 2 onboarding").
    const byStatus: Record<string, number> = {};
    for (const w of rows) if (inScope(scope, w.id)) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    const truncated = list.length < rows.length;
    const data: Record<string, unknown> = { total: rows.length, count: list.length, limit_applied: limit };
    if (named) data.department_note = `Query "${q}" is the ${named.name} department: listed everyone in it (department_id ${named.id}), not only names and titles that contain the word; total is its headcount, by_status splits it`;
    else if (!i.department_id && words.length) {
      // A query word that is a department name, inside a longer query: say the match is on names and titles only.
      const dep = deptRows.find((d) => words.some((w) => w.toLowerCase() === d.name.toLowerCase()));
      if (dep) {
        const n = (await tx.select({ id: workers.id }).from(workers).where(workerWhere(ctx.companyId, { departmentId: dep.id }))).length;
        data.department_note = `Query matched names and titles only; the ${dep.name} department has ${n} people: pass department_id ${dep.id} for the department`;
      }
    }
    if (i.start_from || i.start_to) data.start_window = { from: i.start_from ?? null, to: i.start_to ?? null };
    if (i.limit !== undefined && i.limit !== limit) data.limit_note = `limit ${i.limit} is outside 1 to ${SEARCH_MAX}; used ${limit}`;
    if (truncated) data.truncated_note = `Returned ${list.length} of ${rows.length} matches; narrow with status, state, department_id or the start date window`;
    if (scope) data.access = searchAccess(scope, i, matched.length !== rows.length);
    Object.assign(data, { by_state: byState, by_department: byDepartment, by_status: byStatus, workers: list });
    const window = data.start_window ? ` starting ${i.start_from ?? "any time"} to ${i.start_to ?? "any time"}` : "";
    const inDept = named ? ` in ${named.name}` : "";
    return { data, summary: `Found ${rows.length} ${rows.length === 1 ? "worker" : "workers"}${inDept}${window}${truncated ? ` (showing ${list.length})` : ""}` };
  },
});

/** The open checklist items with status (pending, blocked), owner and due date, plus the done ones by label. */
export async function onboardingFacts(tx: DbTx, workerId: string) {
  const tasks = await listTasks(tx, workerId);
  const open = tasks.filter((t) => t.status !== "done");
  return {
    open_count: open.length, done_count: tasks.length - open.length,
    open_items: open.map((t) => ({ kind: t.kind, label: taskLabel(t.kind), status: t.status, owner: t.owner, due_on: t.dueOn, blocked_reason: t.blockedReason })),
    done: tasks.filter((t) => t.status === "done").map((t) => taskLabel(t.kind)),
  };
}

/** The worker's open offboarding case (else the newest) with every step in order and its status. */
export async function offboardingFacts(tx: DbTx, companyId: string, workerId: string) {
  const cases = await tx.select().from(offboardingCases).where(and(eq(offboardingCases.companyId, companyId), eq(offboardingCases.workerId, workerId))).orderBy(desc(offboardingCases.createdAt), desc(offboardingCases.id));
  const c = cases.find((x) => x.status === "open") ?? cases[0];
  if (!c) return null;
  const dto = await caseDto(tx, c);
  const finished = (s: string) => s === "done" || s === "skipped";
  return {
    case_id: c.id, case_status: c.status, kind: c.kind, last_day: c.lastDay,
    open_count: dto.steps.filter((s) => !finished(s.status)).length, finished_count: dto.steps.filter((s) => finished(s.status)).length,
    steps: dto.steps.map((s) => ({ kind: s.kind, label: STEP_LABEL[s.kind] ?? s.kind, status: s.status, proposal_id: s.proposalId, detail: s.detail })),
  };
}

const GetInput = z.object({ worker_id: z.string(), ...responseFormatField });
type GetInput = z.infer<typeof GetInput>;

const peopleGet = readCommand({
  name: "people.get", domain: "people",
  summary: "Read one worker: role, manager, state, pay, open onboarding items or offboarding steps (masked).",
  description: "Read one worker by worker_id: title, department, manager, state, status, dates, current pay, bank status (last4 only), W-4 summary; for an onboarding worker the open checklist items, for an offboarding worker every case step, each with its status. Detailed adds pay history, the tax profile and employee-entered fields (untrusted). Managers: pay, bank and W-4 for their reports only.",
  input: GetInput,
  untrustedFields: ["worker.preferred_name", "worker.personal_email", "worker.home_address"],
  async run(i: GetInput, ctx, deps) {
    const tx = deps.tx;
    const w = await getWorker(tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const L = await lookups(tx, ctx.companyId);
    const scope = await readScopeOf(tx, ctx);
    if (scope && !inScope(scope, w.id)) {
      // Outside the viewer's reports: directory fields only, and the result says what is withheld and why.
      const name = nameRef(w.firstName, w.lastName, w.id);
      const worker = { id: w.id, name, title: w.title, department: L.dept(w.departmentId), work_state: w.workState, manager: L.person(w.managerId), access: directoryAccess(scope, name) };
      return { data: { worker }, summary: `Read ${name}: directory fields only; pay, bank account, W-4, benefits elections and ID numbers are not shared with ${scope.display}` };
    }
    const today = ptDateOf(ctx.now);
    const rate = (await currentPayRate(tx, w.id, today)) ?? (await payRateHistory(tx, w.id)).at(-1) ?? null;
    const bank = await bankSummary(tx, w.id);
    const tp = await taxProfile(tx, w.id);
    const pay = rate ? { pay_rate_id: rate.id, kind: rate.kind, amount_cents: rate.amountCents, amount_display: formatCents(rate.amountCents, rate.currency as "USD"), effective_from: rate.effectiveFrom, created_action_seq: rate.createdActionSeq } : null;
    const worker: Record<string, unknown> = {
      id: w.id, name: nameRef(w.firstName, w.lastName, w.id), employee_number: w.employeeNumber, type: w.type, status: w.status, title: w.title,
      department: L.dept(w.departmentId), manager: L.person(w.managerId), workplace: L.place(w.workplaceId), work_state: w.workState,
      start_date: w.startDate, end_date: w.endDate, work_email: w.workEmail, pay,
      bank_account: bank.active ? { status: bank.active.status, last4: bank.active.accountLast4, source: bank.active.source } : { status: "missing" },
      w4: tp ? { version: tp.w4Version, filing_status: tp.filingStatus, source: tp.source } : null,
    };
    if (w.status === "invited" || w.status === "onboarding") worker.onboarding = await onboardingFacts(tx, w.id);
    if (w.status === "offboarding" || w.status === "inactive") {
      const off = await offboardingFacts(tx, ctx.companyId, w.id);
      if (off) worker.offboarding = off;
    }
    if (isDetailed(i)) {
      worker.pay_history = (await payRateHistory(tx, w.id)).map((r) => ({ pay_rate_id: r.id, kind: r.kind, amount_cents: r.amountCents, amount_display: formatCents(r.amountCents, r.currency as "USD"), effective_from: r.effectiveFrom, effective_to: r.effectiveTo, created_action_seq: r.createdActionSeq }));
      worker.tax_profile = tp ? { w4_version: tp.w4Version, filing_status: tp.filingStatus, step2_checkbox: tp.step2Checkbox, step3_cents: tp.step3Cents, step4a_cents: tp.step4aCents, step4b_cents: tp.step4bCents, step4c_cents: tp.step4cCents, allowances: tp.allowances, state_filing_status: tp.stateFilingStatus, state_allowances: tp.stateAllowances, source: tp.source } : null;
      worker.ssn = w.ssnLast4 ? `***-**-${w.ssnLast4}` : null;
      worker.preferred_name = w.preferredName ?? "";
      worker.personal_email = w.personalEmail ?? "";
      worker.home_address = homeAddressText(w.homeAddressJson) ?? "";
    }
    return { data: { worker }, summary: `Read ${nameRef(w.firstName, w.lastName, w.id)}` };
  },
});

export const peopleCommands: WeftCommand[] = [peopleSearch, peopleGet, updateProfile, setPayRate, revertPayRate, acceptOffer];
