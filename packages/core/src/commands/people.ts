// people.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { and, asc, like, or } from "drizzle-orm";
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import { workers } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { isDetailed, notFound, ptDateOf, readCommand, responseFormatField } from "../demo/define";
import { nameRef } from "../people/names";
import { acceptOffer, revertPayRate, setPayRate, updateProfile } from "../people/writes";
import { bankSummary, currentPayRate, getWorker, homeAddressText, lookups, payRateHistory, taxProfile, workerWhere } from "../people/queries";

const WorkerStatus = z.enum(["draft", "invited", "onboarding", "active", "offboarding", "inactive"]);
const State = z.enum(["CA", "NY", "TX", "CO"]);

const SearchInput = z.object({
  query: z.string().max(100).optional(),
  state: State.optional(),
  status: WorkerStatus.optional(),
  department_id: z.string().optional(),
  limit: z.number().int().optional(),
  ...responseFormatField,
});
type SearchInput = z.infer<typeof SearchInput>;

const peopleSearch = readCommand({
  name: "people.search", domain: "people",
  summary: "Search workers by name, state, status or department.",
  description: "Search workers by name or title (query), work state, status or department_id. Returns readable names with short ids, title, department, work state, status and start date. Concise by default; detailed adds employee number, manager, workplace and end date. Never returns employee-entered profile fields.",
  input: SearchInput,
  async run(i: SearchInput, ctx, deps) {
    const tx = deps.tx;
    const where = workerWhere(ctx.companyId, { state: i.state, status: i.status, departmentId: i.department_id });
    const q = i.query?.trim();
    const filtered = q ? and(where, or(like(workers.firstName, `%${q}%`), like(workers.lastName, `%${q}%`), like(workers.title, `%${q}%`), like(workers.employeeNumber, `%${q}%`))) : where;
    const rows = await tx.select().from(workers).where(filtered).orderBy(asc(workers.id));
    const limit = Math.min(Math.max(i.limit ?? 20, 1), 50);
    const L = await lookups(tx, ctx.companyId);
    const detailed = isDetailed(i);
    const list = rows.slice(0, limit).map((w) => ({
      id: w.id, name: nameRef(w.firstName, w.lastName, w.id), title: w.title, department: L.dept(w.departmentId), work_state: w.workState, status: w.status, start_date: w.startDate,
      ...(detailed ? { employee_number: w.employeeNumber, type: w.type, manager: L.person(w.managerId), workplace: L.place(w.workplaceId), end_date: w.endDate } : {}),
    }));
    const byState: Record<string, number> = {};
    for (const w of rows) if (w.workState) byState[w.workState] = (byState[w.workState] ?? 0) + 1;
    return { data: { total: rows.length, count: list.length, by_state: byState, workers: list }, summary: `Found ${rows.length} workers` };
  },
});

const GetInput = z.object({ worker_id: z.string(), ...responseFormatField });
type GetInput = z.infer<typeof GetInput>;

const peopleGet = readCommand({
  name: "people.get", domain: "people",
  summary: "Read one worker: role, manager, state, pay and onboarding facts (masked).",
  description: "Read one worker by worker_id: name, title, department, manager, work state, status, dates, current pay (cents and display), bank account status (last4 only) and W-4 summary. Concise by default. Detailed adds pay history, the full tax profile and the employee-entered profile fields, which are untrusted.",
  input: GetInput,
  untrustedFields: ["worker.preferred_name", "worker.personal_email", "worker.home_address"],
  async run(i: GetInput, ctx, deps) {
    const tx = deps.tx;
    const w = await getWorker(tx, ctx.companyId, i.worker_id);
    if (!w) throw notFound("worker", i.worker_id);
    const L = await lookups(tx, ctx.companyId);
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
