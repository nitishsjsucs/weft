// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-compliance.
// Planned: compliance.*, tax filings (tax.list_filings, tax.prepare_filing, tax.file_return), handoffs.*, training.*, notices.upload and notices.ingest_upload. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
//
// Beyond the planned table (contract request in docs/tracks/w4-parity-compliance.md): tax.set_deposit_schedule (R2,
// always, checked against a deposit schedule notice like tax.update_rate) and notices.acknowledge (R1, only for the
// informational kinds NOTICE_HANDLING marks acknowledge).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ComplianceItemKind, ComplianceItemStatus, FilingForm, formatCents, HandoffKind, HandoffReason, NOTICE_HANDLING } from "@weft/contracts";
import { filings, handoffCases, notices, proposals, simAgencyMail, taxAccounts, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, isDetailed, notFound, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { AGENCY_LABELS } from "../tax/queries";
import { parseExtract } from "../notices/queries";
import { listCalendar, refreshCalendar } from "../compliance/calendar";
import { evidenceFor, getHandoff, HANDOFF_ASSIGNEE, handoffEmail, listHandoffs, openCaseFor, toHandoffDto } from "../compliance/handoffs";
import { isPreparable, prepareFiling, type PreparedFiling } from "../compliance/prepare";
import { periodBounds, RULE_BY_FORM } from "../compliance/rules";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
type FilingRow = typeof filings.$inferSelect;

// ---------------------------------------------------------------- shared reads

async function filingsOf(tx: DbTx, companyId: string): Promise<(FilingRow & { agency: string; accountNumber: string | null })[]> {
  const rows = await tx.select({ f: filings, agency: taxAccounts.agency, accountNumber: taxAccounts.accountNumber }).from(filings)
    .innerJoin(taxAccounts, eq(filings.taxAccountId, taxAccounts.id)).where(eq(taxAccounts.companyId, companyId));
  return rows.map((r) => ({ ...r.f, agency: r.agency, accountNumber: r.accountNumber })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function filingById(tx: DbTx, companyId: string, id: string) {
  const f = (await filingsOf(tx, companyId)).find((x) => x.id === id);
  if (!f) throw notFound("filing", id);
  return f;
}

export function preparedOf(f: Pick<FilingRow, "preparedJson">): PreparedFiling | null {
  if (!f.preparedJson) return null;
  try { return JSON.parse(f.preparedJson as string) as PreparedFiling; } catch { return null; }
}

/** The pending tax.file_return proposal for a filing, if any (the executor owns the proposal row). */
async function pendingFileProposal(tx: DbTx, companyId: string, filingId: string): Promise<string | null> {
  const rows = await tx.select({ id: proposals.id, status: proposals.status, command: proposals.command }).from(proposals)
    .where(and(eq(proposals.companyId, companyId), eq(proposals.subjectRef, filingId)));
  return rows.find((p) => p.command === "tax.file_return" && p.status === "pending")?.id ?? null;
}

const label = (form: string) => RULE_BY_FORM[form as FilingForm]?.label ?? form;

function filingSummary(f: FilingRow & { agency: string; accountNumber: string | null }, today: string, pendingProposalId: string | null = null) {
  const p = preparedOf(f);
  return {
    id: f.id, form: f.form, form_label: label(f.form), period: f.period, agency: f.agency, agency_label: AGENCY_LABELS[f.agency] ?? f.agency,
    status: f.status, due_on: f.dueOn, filed_at: f.filedAt, confirmation: f.confirmation, prepared: !!p, period_open: today <= periodBounds(f.period).end,
    total_due_cents: p?.total_due_cents ?? null, total_due_display: p ? formatCents(p.total_due_cents) : null,
    balance_due_cents: p?.balance_due_cents ?? null, pending_proposal_id: pendingProposalId ?? f.proposalId,
    source_url: RULE_BY_FORM[f.form as FilingForm]?.sourceUrl ?? null,
  };
}

// ---------------------------------------------------------------- compliance.calendar and refresh

const CalendarInput = z.object({ from: isoDate.optional(), to: isoDate.optional(), kind: ComplianceItemKind.optional(), status: ComplianceItemStatus.optional(), ...responseFormatField });
type CalendarInput = z.infer<typeof CalendarInput>;
const calendarCmd = readCommand({
  name: "compliance.calendar", domain: "tax",
  summary: "Compliance calendar: filings, deposits, notice replies, training and contractor forms by due date.",
  description: "List compliance calendar rows by due date: quarterly and annual filings, federal tax deposits, notice reply deadlines, required training and contractor tax form expiries. Each row has kind, title, due_on, days_left and status (upcoming, due_soon within 14 days, prepared, proposed, done, overdue). Filter by from, to, kind or status.",
  input: CalendarInput,
  async run(i: CalendarInput, ctx, deps) {
    const today = ptDateOf(ctx.now);
    const rows = await listCalendar(deps.tx, ctx.companyId, today, { from: i.from, to: i.to, kind: i.kind, status: i.status });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const items = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, due_on: r.dueOn, days_left: r.daysLeft, status: r.status, subject_ref: r.subjectRef, form: r.form, period: r.period,
      ...(isDetailed(i) ? { jurisdiction: r.jurisdiction, agency: r.agency, proposal_id: r.proposalId, source_url: r.sourceUrl } : {}) }));
    return { data: { as_of: today, count: items.length, by_status: counts, items }, summary: `Listed ${items.length} compliance calendar rows` };
  },
});

export const refreshCalendarCmd = writeCommand({
  name: "compliance.refresh_calendar", summary: "System: rebuild the compliance calendar from rules and records.",
  description: "System command (svc_events on payroll.processed and the daily clock tick): ensures filing rows for the current and previous period of every active account, upserts calendar rows from filings, deposits, notices, training and contractor forms, and emits compliance.item_due_soon and compliance.item_overdue for rows that just changed.",
  input: z.object({}).strict(), domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(_i, ctx, deps) {
    const r = await refreshCalendar(deps.tx, { newId: (p) => deps.newId(p as never), now: ctx.now }, ctx.companyId, ptDateOf(ctx.now));
    return {
      data: { ...r }, summary: `Refreshed the compliance calendar: ${r.created} new, ${r.updated} updated, ${r.due_soon.length} due soon, ${r.overdue.length} overdue`,
      events: [
        ...r.due_soon.map((id) => ({ type: "compliance.item_due_soon", subjectRef: id, payload: { item_id: id } })),
        ...r.overdue.map((id) => ({ type: "compliance.item_overdue", subjectRef: id, payload: { item_id: id } })),
      ],
    };
  },
});

// ---------------------------------------------------------------- filings

const ListFilingsInput = z.object({ form: FilingForm.optional(), period: z.string().max(10).optional(), status: z.enum(["draft", "filed", "accepted", "rejected"]).optional(), ...responseFormatField });
type ListFilingsInput = z.infer<typeof ListFilingsInput>;
const listFilingsCmd = readCommand({
  name: "tax.list_filings", domain: "tax",
  summary: "List quarterly and annual filings with due dates and status.",
  description: "List the company's filings (Form 941, 940, W-2 and W-3, 1099-NEC and the state wage reports) with form, period (2026-Q3 or 2026), agency, status (draft, filed, accepted), due date, whether it is prepared, the prepared total and any pending tax.file_return proposal. Filter by form, period or status.",
  input: ListFilingsInput,
  async run(i: ListFilingsInput, ctx, deps) {
    const today = ptDateOf(ctx.now);
    const rows = (await filingsOf(deps.tx, ctx.companyId)).filter((f) => (!i.form || f.form === i.form) && (!i.period || f.period === i.period) && (!i.status || f.status === i.status));
    const out = [];
    for (const f of rows) out.push(filingSummary(f, today, await pendingFileProposal(deps.tx, ctx.companyId, f.id)));
    return { data: { count: out.length, filings: out }, summary: `Listed ${out.length} filings` };
  },
});

const GetFilingInput = z.object({ filing_id: z.string().startsWith("fil_"), ...responseFormatField });
type GetFilingInput = z.infer<typeof GetFilingInput>;
const getFilingCmd = readCommand({
  name: "tax.get_filing", domain: "tax",
  summary: "Read one filing: status, due date and its prepared lines in cents.",
  description: "Read one filing by filing_id: form, period, agency, status, due date, confirmation once filed, the rule's source URL, and the prepared return: every line with cents, the runs it was built from, coverage, total due, deposits and balance due. Detailed adds the per-employee rows. Prepare it first with tax.prepare_filing.",
  input: GetFilingInput,
  async run(i: GetFilingInput, ctx, deps) {
    const f = await filingById(deps.tx, ctx.companyId, i.filing_id);
    const p = preparedOf(f);
    const prepared = p ? {
      lines: p.lines.map((l) => ({ ...l, display: l.cents === null ? null : formatCents(l.cents) })), runs: p.runs, coverage: p.coverage, prepared_hash: p.prepared_hash,
      total_due_cents: p.total_due_cents, deposits_cents: p.deposits_cents, balance_due_cents: p.balance_due_cents, employee_count: p.employees.length,
      ...(isDetailed(i) ? { employees: p.employees } : {}),
    } : null;
    return { data: { filing: { ...filingSummary(f, ptDateOf(ctx.now), await pendingFileProposal(deps.tx, ctx.companyId, f.id)), prepared } }, summary: `Read ${label(f.form)} for ${f.period}` };
  },
});

const FilingIdInput = z.object({ filing_id: z.string().startsWith("fil_") });
type FilingIdInput = z.infer<typeof FilingIdInput>;

export const prepareFilingCmd = writeCommand<FilingIdInput>({
  name: "tax.prepare_filing", summary: "Prepare a filing from processed payroll (R1, no approval).",
  description: "Prepare a filing (filing_id from tax.list_filings) from processed payroll: quarterly returns from the paychecks of runs paid in the quarter, annual returns from the YTD ledger. Stores every line in cents and returns the totals. R1: no approval; nothing is sent. Filing it is tax.file_return. Example: {\"filing_id\":\"fil_0001\"}",
  input: FilingIdInput, domain: "tax", needs: "edit", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  tiers: { main: "executable", task: "executable" }, lease: (i) => `filing:${i.filing_id}`,
  async run(i, ctx, deps) {
    const f = await filingById(deps.tx, ctx.companyId, i.filing_id);
    if (f.status === "filed" || f.status === "accepted") throw new DomainRefusal("DOMAIN_FILING_FILED", `${f.id} was filed on ${f.filedAt?.slice(0, 10)} (${f.confirmation})`, "A filed return cannot be prepared again", null);
    if (!isPreparable(f.form as FilingForm)) throw new DomainRefusal("DOMAIN_NOT_PREPARABLE", `${label(f.form)} is not prepared by Weft yet`, null, null);
    const p = await prepareFiling(deps.tx, ctx.companyId, f.form as FilingForm, f.period);
    await deps.tx.update(filings).set({ preparedJson: JSON.stringify(p) }).where(eq(filings.id, f.id));
    return {
      data: { filing_id: f.id, form: f.form, period: f.period, runs: p.runs, total_due_cents: p.total_due_cents, total_due_display: formatCents(p.total_due_cents), deposits_cents: p.deposits_cents,
        balance_due_cents: p.balance_due_cents, balance_due_display: formatCents(p.balance_due_cents), line_count: p.lines.length, employee_count: p.employees.length, prepared_hash: p.prepared_hash,
        period_open: ptDateOf(ctx.now) <= p.period_end },
      summary: `Prepared ${label(f.form)} for ${f.period}: ${formatCents(p.total_due_cents)} due, ${formatCents(p.balance_due_cents)} balance`,
      events: [{ type: "filing.prepared", subjectRef: f.id, payload: { filing_id: f.id } }],
    };
  },
});

async function fileable(i: FilingIdInput, companyId: string, now: string, tx: DbTx) {
  const f = await filingById(tx, companyId, i.filing_id);
  if (f.status === "filed" || f.status === "accepted") throw new DomainRefusal("DOMAIN_FILING_FILED", `${f.id} was already filed (${f.confirmation})`, null, null);
  const p = preparedOf(f);
  if (!p) throw new DomainRefusal("DOMAIN_NOT_PREPARED", `${f.id} is not prepared`, "Call tax.prepare_filing first", { filing_id: f.id });
  const today = ptDateOf(now);
  if (today <= p.period_end) throw new DomainRefusal("DOMAIN_PERIOD_OPEN", `${label(f.form)} for ${f.period} cannot be filed before the period ends on ${p.period_end}`, null, null);
  // The stored preparation must still match processed payroll; a run processed since then means prepare again.
  const fresh = await prepareFiling(tx, companyId, f.form as FilingForm, f.period);
  if (fresh.prepared_hash !== p.prepared_hash) throw new DomainRefusal("DOMAIN_PREPARATION_STALE", `${f.id} changed since it was prepared`, "Call tax.prepare_filing again", { filing_id: f.id });
  return { f, p };
}

export const NOT_REVERSIBLE_FILING = "Not reversible: a return filed with the agency can only be corrected by an amended return";

export const fileReturnCmd = writeCommand<FilingIdInput>({
  name: "tax.file_return", summary: "File a prepared return with the agency simulator (R4, always a proposal).",
  description: "Propose filing a prepared return (filing_id) with its agency simulator. R4: always needs a person's approval and never executes from an agent; not reversible (only an amended return corrects it). The preview shows every total, the runs it covers and the balance due. Refused until the period has ended and the return is prepared and current.",
  input: FilingIdInput, domain: "tax", needs: "edit", effect: "external", risk: riskOf("R4"), approval: "always", reversible: false,
  lease: (i) => `filing:${i.filing_id}`,
  errorHints: { DOMAIN_NOT_PREPARED: { hint: "Prepare the return first with tax.prepare_filing", example: { filing_id: "fil_0001" } } },
  async preview(i, ctx, deps) {
    const { f, p } = await fileable(i, ctx.companyId, ctx.now, deps.tx);
    const agency = AGENCY_LABELS[f.agency] ?? f.agency;
    const key = p.lines.filter((l) => l.cents !== null && ["2", "3", "5e", "10", "12", "13", "14", "subject", "ui", "pit", "total", "deposits", "balance", "7", "8", "1"].includes(l.line));
    return {
      title: `File ${label(f.form)} for ${f.period} with ${agency}: ${formatCents(p.total_due_cents)} total, ${formatCents(p.balance_due_cents)} balance due`,
      diff: [{ label: `${label(f.form)} ${f.period}`, before: "draft", after: "filed" }],
      content: [
        { label: "Return lines", text: key.map((l) => `Line ${l.line} ${l.label}: ${formatCents(l.cents!)}`).join("\n") },
        { label: "Coverage", text: p.coverage },
      ],
      moneyCents: p.balance_due_cents > 0 ? p.balance_due_cents : null, subjectRef: f.id,
      subjectHash: sha256Hex(canonicalJson({ filing: f.id, status: f.status, prepared: p.prepared_hash })),
      evidence: [{ label: "Filing", ref: f.id }, ...p.runs.filter((r) => r.startsWith("pay_")).map((r) => ({ label: "Payroll run", ref: r })), { label: "Filing rule", ref: RULE_BY_FORM[f.form as FilingForm].sourceUrl }, { label: "Not reversible", ref: NOT_REVERSIBLE_FILING }],
    };
  },
  async run(i, ctx, deps) {
    const { f, p } = await fileable(i, ctx.companyId, ctx.now, deps.tx);
    const [acct] = await deps.tx.select().from(taxAccounts).where(eq(taxAccounts.id, f.taxAccountId)).limit(1);
    // The agency portal credential is resolved in memory to authenticate the simulated filing; it is never stored or returned.
    const credential = await deps.resolveCredential((acct?.credentialRef ?? `vault:${f.agency.replace("_", "-")}-portal`) as `vault:${string}`);
    if (credential.length < 8) throw new DomainRefusal("DOMAIN_AGENCY_AUTH", `The ${AGENCY_LABELS[f.agency] ?? f.agency} portal rejected the credential`, "Ask a human to check the vault entry", null);
    const mailId = await deps.newId("simm_");
    const confirmation = `${f.agency.toUpperCase().replace("_", "-")}-F-${mailId.slice(5)}`;
    await deps.tx.insert(simAgencyMail).values({ id: mailId, agency: f.agency, direction: "out", kind: "return_filing", body: canonicalJson({ form: f.form, period: f.period, lines: p.lines }), relatedNoticeId: null, confirmation, credentialName: acct?.credentialRef ?? null, ts: ctx.now });
    await deps.tx.update(filings).set({ status: "filed", filedAt: ctx.now, confirmation, proposalId: ctx.approvedProposalId ?? f.proposalId }).where(eq(filings.id, f.id));
    return {
      data: { filing_id: f.id, form: f.form, period: f.period, status: "filed", confirmation, total_due_cents: p.total_due_cents, balance_due_cents: p.balance_due_cents, not_reversible_reason: NOT_REVERSIBLE_FILING },
      summary: `Filed ${label(f.form)} for ${f.period} with ${AGENCY_LABELS[f.agency] ?? f.agency} (${confirmation})`,
      events: [{ type: "filing.filed", subjectRef: f.id, payload: { filing_id: f.id } }],
      ...(p.balance_due_cents > 0 ? { moneyCents: p.balance_due_cents } : {}),
    };
  },
});

// ---------------------------------------------------------------- hand-offs

const ListHandoffsInput = z.object({ kind: HandoffKind.optional(), status: z.enum(["open", "acknowledged", "resolved", "cancelled"]).optional(), ...responseFormatField });
type ListHandoffsInput = z.infer<typeof ListHandoffsInput>;
const listHandoffsCmd = readCommand({
  name: "handoffs.list", domain: "tax",
  summary: "List hand-offs to a person (tax specialist, HR person, vendor specialist).",
  description: "List hand-off cases: kind (tax_specialist, hr_person, vendor_specialist), reason code, subject, status (open, acknowledged, resolved, cancelled), assignee and the evidence pack refs. Filter by kind or status. Summaries are written by Weft or the agent from structured fields.",
  input: ListHandoffsInput,
  async run(i: ListHandoffsInput, ctx, deps) {
    const rows = (await listHandoffs(deps.tx, ctx.companyId, { kind: i.kind, status: i.status })).map(toHandoffDto);
    const cases = rows.map((c) => ({ id: c.id, kind: c.kind, reason: c.reason, subject_ref: c.subjectRef, status: c.status, assignee: c.assigneeName, created_at: c.createdAt,
      ...(isDetailed(i) ? { summary: c.summary, evidence: c.evidence, run_id: c.runId, resolved_at: c.resolvedAt } : {}) }));
    return { data: { count: cases.length, cases }, summary: `Listed ${cases.length} hand-offs` };
  },
});

const OpenInput = z.object({
  kind: HandoffKind, reason: HandoffReason, subject_ref: z.string().max(40).optional(), worker_id: z.string().startsWith("wrk_").optional(),
  summary: z.string().min(1).max(400),
});
type OpenInput = z.infer<typeof OpenInput>;
export const openHandoffCmd = writeCommand<OpenInput>({
  name: "handoffs.open", summary: "Hand a case to a person with an evidence pack (R1).",
  description: "Open a hand-off to a person: kind tax_specialist, hr_person or vendor_specialist; a reason code; subject_ref (a notice, filing or other id) and a one-paragraph summary up to 400 characters. A notice subject gets the evidence pack (notice, tax account, filings, parser extract) and turns escalated. One open case per subject. R1, no approval.",
  input: OpenInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null,
  tiers: { main: "executable", task: "delegated" }, lease: (i) => `handoff:${i.subject_ref ?? i.worker_id ?? "none"}`,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    if (i.subject_ref) {
      const dup = await openCaseFor(tx, ctx.companyId, i.subject_ref);
      if (dup) return { data: { handoff_id: dup.id, status: dup.status, duplicate: true, kind: dup.kind }, summary: `Hand-off ${dup.id} is already open for ${i.subject_ref}` };
    }
    const { notice, evidence } = await evidenceFor(tx, ctx.companyId, i.subject_ref ?? null);
    if (i.subject_ref?.startsWith("ntc_") && !notice) throw notFound("notice", i.subject_ref);
    const id = await deps.newId("hnd_");
    const summary = i.summary.replace(/[<>]/g, "").trim();
    const opener = ctx.principal.kind === "human" ? ctx.principal.id : ctx.onBehalfOf ?? ctx.principal.id;
    const who = HANDOFF_ASSIGNEE[i.kind];
    await tx.insert(handoffCases).values({
      id, companyId: ctx.companyId, kind: i.kind, reason: i.reason, subjectRef: i.subject_ref ?? null, workerId: i.worker_id ?? null, summary, evidenceJson: JSON.stringify(evidence),
      status: "open", assigneePrincipalId: who.principal, openedBy: opener, runId: ctx.run?.id ?? null, createdAt: ctx.now, resolvedAt: null, resolutionNote: null,
    });
    if (notice && notice.status !== "resolved" && notice.status !== "escalated") {
      const resolution = { outcome: "escalated", reason_code: i.reason, reason: summary, specialist: who.name, specialist_principal: who.principal, escalated_at: ctx.now, escalated_by: opener, previous_status: notice.status, evidence, handoff_id: id };
      await tx.update(notices).set({ status: "escalated", resolutionJson: JSON.stringify(resolution) }).where(eq(notices.id, notice.id));
    }
    const mail = handoffEmail({ id, kind: i.kind, reason: i.reason, summary, subjectRef: i.subject_ref ?? null, evidence });
    const sent = await deps.sims.email.send({ to: who.email, from: "agent@larkspur.example", subject: mail.subject, body: mail.body, kind: "generic", relatedRef: id });
    return {
      data: { handoff_id: id, kind: i.kind, reason: i.reason, status: "open", assignee: who.name, evidence, email_id: sent.id, notice_escalated: !!notice },
      summary: `Handed ${i.subject_ref ?? "the case"} to the ${who.name.toLowerCase()} as ${id} with ${evidence.length} evidence items`,
      events: [{ type: "handoff.opened", subjectRef: id, payload: { handoff_id: id } }],
    };
  },
});

const ResolveInput = z.object({ handoff_id: z.string().startsWith("hnd_"), note: z.string().max(400).optional(), status: z.enum(["acknowledged", "resolved", "cancelled"]).optional() });
type ResolveInput = z.infer<typeof ResolveInput>;
export const resolveHandoffCmd = writeCommand<ResolveInput>({
  name: "handoffs.resolve", summary: "A person acknowledges, resolves or cancels a hand-off.",
  description: "Human only: the person who took a hand-off acknowledges it, resolves it with a note, or cancels it. Resolving a notice hand-off does not change the notice; the specialist's reply is recorded on the case.",
  input: ResolveInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const c = await getHandoff(deps.tx, ctx.companyId, i.handoff_id);
    if (!c) throw notFound("hand-off", i.handoff_id);
    if (c.status === "resolved" || c.status === "cancelled") throw new DomainRefusal("DOMAIN_HANDOFF_CLOSED", `${c.id} is already ${c.status}`, null, null);
    const status = i.status ?? "resolved";
    const closed = status === "resolved" || status === "cancelled";
    await deps.tx.update(handoffCases).set({ status, resolvedAt: closed ? ctx.now : null, resolutionNote: (i.note ?? "").replace(/[<>]/g, "").trim() || null }).where(eq(handoffCases.id, c.id));
    return {
      data: { handoff_id: c.id, status, previous_status: c.status },
      summary: `Marked hand-off ${c.id} ${status}`,
      events: closed ? [{ type: "handoff.resolved", subjectRef: c.id, payload: { handoff_id: c.id } }] : [],
    };
  },
});

// ---------------------------------------------------------------- notice handling beyond rate changes

const Schedule = z.enum(["monthly", "semiweekly"]);
const DepositInput = z.object({ tax_account_id: z.string().startsWith("txa_"), schedule: Schedule, effective_from: isoDate, source_notice_id: z.string().startsWith("ntc_") });
type DepositInput = z.infer<typeof DepositInput>;

async function checkDepositNotice(i: DepositInput, companyId: string, tx: DbTx) {
  const [n] = await tx.select().from(notices).where(and(eq(notices.companyId, companyId), eq(notices.id, i.source_notice_id))).limit(1);
  if (!n) throw notFound("notice", i.source_notice_id);
  const [acct] = await tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, companyId), eq(taxAccounts.id, i.tax_account_id))).limit(1);
  if (!acct) throw notFound("tax account", i.tax_account_id);
  const ex = parseExtract(n.extractedJson as string | null);
  const derived = ex && n.kind === "deposit_schedule_change" && ex.period && ex.effectiveFrom && n.taxAccountId
    ? { tax_account_id: n.taxAccountId, schedule: ex.period, effective_from: ex.effectiveFrom, source_notice_id: n.id } : null;
  const ok = derived && derived.tax_account_id === i.tax_account_id && derived.schedule === i.schedule && derived.effective_from === i.effective_from;
  if (!ok) {
    const hint = derived ? `The notice ${n.id} says: account ${derived.tax_account_id}, ${derived.schedule} schedule effective ${derived.effective_from}` : `Notice ${n.id} carries no deposit schedule change`;
    throw new DomainRefusal("DOMAIN_NOTICE_MISMATCH", `The deposit schedule change does not match the notice's extracted fields. ${hint}`, hint, derived);
  }
  return { n, acct };
}

export const setDepositScheduleCmd = writeCommand<DepositInput>({
  name: "tax.set_deposit_schedule", summary: "Change a tax account's deposit schedule from an agency notice (R2).",
  description: "Propose changing an agency tax account's deposit schedule (monthly or semiweekly) from a deposit schedule notice (source_notice_id), with the effective date the notice states. Checked against the notice's extracted fields; a mismatch is refused with the derived values. R2: always needs approval.",
  input: DepositInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", reversible: false, lease: (i) => `deposit_schedule:${i.tax_account_id}`,
  async preview(i, ctx, deps) {
    const { n, acct } = await checkDepositNotice(i, ctx.companyId, deps.tx);
    return {
      title: `Change the ${AGENCY_LABELS[acct.agency] ?? acct.agency} deposit schedule from ${acct.depositSchedule ?? "none"} to ${i.schedule} effective ${i.effective_from}`,
      diff: [{ label: `${acct.jurisdiction} deposit schedule (${acct.id})`, before: acct.depositSchedule ?? "none", after: i.schedule }], content: [], moneyCents: null, subjectRef: acct.id,
      subjectHash: sha256Hex(canonicalJson({ account: acct.id, schedule: acct.depositSchedule, notice: n.id })), evidence: [{ label: "Notice", ref: n.id }, { label: "Tax account", ref: acct.id }],
    };
  },
  async run(i, ctx, deps) {
    const { n, acct } = await checkDepositNotice(i, ctx.companyId, deps.tx);
    await deps.tx.update(taxAccounts).set({ depositSchedule: i.schedule }).where(eq(taxAccounts.id, acct.id));
    await deps.tx.update(notices).set({ status: "resolved", resolutionJson: JSON.stringify({ outcome: "deposit_schedule_updated", from: acct.depositSchedule, to: i.schedule, effective_from: i.effective_from, resolved_at: ctx.now }) }).where(eq(notices.id, n.id));
    return {
      data: { tax_account_id: acct.id, previous_schedule: acct.depositSchedule, schedule: i.schedule, effective_from: i.effective_from, notice_id: n.id },
      summary: `Set the ${AGENCY_LABELS[acct.agency] ?? acct.agency} deposit schedule to ${i.schedule} effective ${i.effective_from}`,
      events: [{ type: "notice.resolved", subjectRef: n.id, payload: { notice_id: n.id } }],
    };
  },
});

const AckInput = z.object({ notice_id: z.string().startsWith("ntc_") });
export const acknowledgeNoticeCmd = writeCommand<z.infer<typeof AckInput>>({
  name: "notices.acknowledge", summary: "Record an informational notice as read (R1).",
  description: "Record an informational agency notice (a kind that needs no reply, such as a FUTA credit reduction or a registration confirmation) as acknowledged and resolved. Refused for any kind that needs a reply or a change. R1, no approval.",
  input: AckInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false, preview: null, lease: (i) => `notice:${i.notice_id}`,
  async run(i, ctx, deps) {
    const [n] = await deps.tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.id, i.notice_id))).limit(1);
    if (!n) throw notFound("notice", i.notice_id);
    if (NOTICE_HANDLING[n.kind] !== "acknowledge") throw new DomainRefusal("DOMAIN_NEEDS_ACTION", `A ${n.kind} notice needs a reply or a change, not an acknowledgment`, "Use the handling for its kind, or hand it to a person with handoffs.open", null);
    if (n.status === "resolved") return { data: { notice_id: n.id, status: "resolved", already: true }, summary: `${n.id} is already resolved` };
    await deps.tx.update(notices).set({ status: "resolved", resolutionJson: JSON.stringify({ outcome: "acknowledged", resolved_at: ctx.now }) }).where(eq(notices.id, n.id));
    return { data: { notice_id: n.id, status: "resolved" }, summary: `Acknowledged ${n.formCode} notice ${n.id}`, events: [{ type: "notice.resolved", subjectRef: n.id, payload: { notice_id: n.id } }] };
  },
});

export const w4ComplianceCommands: WeftCommand[] = [
  calendarCmd, refreshCalendarCmd, listFilingsCmd, getFilingCmd, prepareFilingCmd, fileReturnCmd,
  listHandoffsCmd, openHandoffCmd, resolveHandoffCmd, setDepositScheduleCmd, acknowledgeNoticeCmd,
];
