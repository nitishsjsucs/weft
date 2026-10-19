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
import { AgencyCode, AgencyNoticeKind, ComplianceItemKind, ComplianceItemStatus, FilingForm, formatCents, HandoffKind, HandoffReason, NOTICE_HANDLING, TrainingCourseCode } from "@weft/contracts";
import { filings, handoffCases, notices, principals, proposals, simAgencyMail, taxAccounts, trainingAssignments, uploads, workers, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { DomainRefusal, isDetailed, notFound, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { readScopeOf, reportsAccess, splitByScope } from "../people/scope";
import { AGENCY_LABELS } from "../tax/queries";
import { ratesAlreadyInEffect } from "../tax/writes";
import { parseExtract } from "../notices/queries";
import { listCalendar, refreshCalendar } from "../compliance/calendar";
import { evidenceFor, getHandoff, HANDOFF_ASSIGNEE, handoffEmail, listHandoffs, openCaseFor, toHandoffDto } from "../compliance/handoffs";
import { isPreparable, prepareFiling, type PreparedFiling } from "../compliance/prepare";
import { periodBounds, RULE_BY_FORM } from "../compliance/rules";
import { addDays, ensureCourses, getAssignment, listAssignments, missingAssignments, RULE_BY_CODE } from "../compliance/training";
import { MIN_EXTRACT_CONFIDENCE, planNotice } from "../../../contracts/src/ext/w4-parity-compliance";
import { extractUpload } from "../../../sim/src/notices/mailed";

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
    const opener = ctx.principal.kind === "human" ? ctx.principal.id : ctx.onBehalfOf ?? ctx.principal.id;
    const r = await createHandoff(deps, ctx.companyId, ctx.now, { kind: i.kind, reason: i.reason, subjectRef: i.subject_ref ?? null, workerId: i.worker_id ?? null, summary: i.summary, openedBy: opener, runId: ctx.run?.id ?? null });
    if (r.duplicate) return { data: { handoff_id: r.id, status: r.status, duplicate: true, kind: r.kind }, summary: `Hand-off ${r.id} is already open for ${i.subject_ref}` };
    return {
      data: { handoff_id: r.id, kind: i.kind, reason: i.reason, status: "open", assignee: r.assignee, evidence: r.evidence, email_id: r.emailId, notice_escalated: r.noticeEscalated },
      summary: `Handed ${i.subject_ref ?? "the case"} to the ${r.assignee.toLowerCase()} as ${r.id} with ${r.evidence.length} evidence items`,
      events: [{ type: "handoff.opened", subjectRef: r.id, payload: { handoff_id: r.id } }],
    };
  },
});

/** Opens a hand-off (one open case per subject); a notice subject gets the evidence pack and turns escalated. */
async function createHandoff(deps: CommandDeps, companyId: string, now: string,
  i: { kind: z.infer<typeof HandoffKind>; reason: z.infer<typeof HandoffReason>; subjectRef: string | null; workerId: string | null; summary: string; openedBy: string; runId: string | null }) {
  const tx = deps.tx;
  if (i.subjectRef) {
    const dup = await openCaseFor(tx, companyId, i.subjectRef);
    if (dup) return { duplicate: true as const, id: dup.id, status: dup.status, kind: dup.kind };
  }
  const { notice, evidence } = await evidenceFor(tx, companyId, i.subjectRef);
  if (i.subjectRef?.startsWith("ntc_") && !notice) throw notFound("notice", i.subjectRef);
  const id = await deps.newId("hnd_");
  const summary = i.summary.replace(/[<>]/g, "").trim();
  const who = HANDOFF_ASSIGNEE[i.kind];
  await tx.insert(handoffCases).values({
    id, companyId, kind: i.kind, reason: i.reason, subjectRef: i.subjectRef, workerId: i.workerId, summary, evidenceJson: JSON.stringify(evidence),
    status: "open", assigneePrincipalId: who.principal, openedBy: i.openedBy, runId: i.runId, createdAt: now, resolvedAt: null, resolutionNote: null,
  });
  if (notice && notice.status !== "resolved" && notice.status !== "escalated") {
    const resolution = { outcome: "escalated", reason_code: i.reason, reason: summary, specialist: who.name, specialist_principal: who.principal, escalated_at: now, escalated_by: i.openedBy, previous_status: notice.status, evidence, handoff_id: id };
    await tx.update(notices).set({ status: "escalated", resolutionJson: JSON.stringify(resolution) }).where(eq(notices.id, notice.id));
  }
  const mail = handoffEmail({ id, kind: i.kind, reason: i.reason, summary, subjectRef: i.subjectRef, evidence });
  const sent = await deps.sims.email.send({ to: who.email, from: "agent@larkspur.example", subject: mail.subject, body: mail.body, kind: "generic", relatedRef: id });
  return { duplicate: false as const, id, status: "open", kind: i.kind, assignee: who.name, evidence, emailId: sent.id, noticeEscalated: !!notice };
}

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
    if (n.source === "upload" && ctx.principal.kind !== "human") throw new DomainRefusal("DOMAIN_UPLOAD_NEEDS_PERSON", `${n.id} was uploaded by a person, so a person closes it`, "Hand it to a tax specialist with handoffs.open", null);
    // A rate notice that only confirms the rates already in effect changes nothing, so it is acknowledged like an
    // informational one (review fix group notices-and-proposals); any rate that differs still needs tax.update_rate.
    const confirmed = NOTICE_HANDLING[n.kind] === "acknowledge" ? null : await ratesAlreadyInEffect(deps.tx, ctx.companyId, n);
    if (NOTICE_HANDLING[n.kind] !== "acknowledge" && !confirmed) throw new DomainRefusal("DOMAIN_NEEDS_ACTION", `A ${n.kind} notice needs a reply or a change, not an acknowledgment`, "Use the handling for its kind, or hand it to a person with handoffs.open", null);
    if (n.status === "resolved") return { data: { notice_id: n.id, status: "resolved", already: true }, summary: `${n.id} is already resolved` };
    await deps.tx.update(notices).set({ status: "resolved", resolutionJson: JSON.stringify({ outcome: "acknowledged", resolved_at: ctx.now, ...(confirmed ? { rates_in_effect: confirmed } : {}) }) }).where(eq(notices.id, n.id));
    return { data: { notice_id: n.id, status: "resolved", ...(confirmed ? { rates_in_effect: confirmed } : {}) }, summary: `Acknowledged ${n.formCode} notice ${n.id}${confirmed ? ` (confirms the rates in effect)` : ""}`, events: [{ type: "notice.resolved", subjectRef: n.id, payload: { notice_id: n.id } }] };
  },
});

// ---------------------------------------------------------------- due-soon reminders

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** The reminder text, written in code from calendar rows (so every number and date comes from the calendar). */
export async function reminderText(tx: DbTx, companyId: string, today: string): Promise<{ text: string | null; ids: string[] }> {
  const rows = (await listCalendar(tx, companyId, today)).filter((r) => r.status === "due_soon" || r.status === "overdue" || (r.status === "prepared" || r.status === "proposed") && r.daysLeft <= 14);
  if (!rows.length) return { text: null, ids: [] };
  const lines = rows.slice(0, 12).map((r) => `- ${r.title}: ${r.status === "overdue" ? `overdue since ${short(r.dueOn)}` : `due ${short(r.dueOn)}`}${r.status === "prepared" ? " (prepared)" : r.status === "proposed" ? " (waiting for approval)" : ""}`);
  const more = rows.length > 12 ? `\n- and ${rows.length - 12} more on the compliance calendar` : "";
  return { text: `Compliance due soon:\n${lines.join("\n")}${more}\nDetails are on the Taxes & Compliance calendar in Weft.`, ids: rows.map((r) => r.id) };
}

const RemindInput = z.object({ channel: z.enum(["#payroll", "#people-ops"]).optional() });
type RemindInput = z.infer<typeof RemindInput>;
export const postRemindersCmd = writeCommand<RemindInput>({
  name: "compliance.post_reminders", summary: "Post the due-soon and overdue calendar rows to a chat channel (R3).",
  description: "Post the compliance calendar rows that are due within 14 days or overdue to #payroll (or #people-ops). The text is written in code from the calendar, so every date is grounded; nothing to write yourself. R3 like comms.send_message: runs for an untainted main agent, otherwise a proposal. Example: {\"channel\":\"#payroll\"}",
  input: RemindInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const { text, ids } = await reminderText(deps.tx, ctx.companyId, ptDateOf(ctx.now));
    if (!text) throw new DomainRefusal("DOMAIN_NOTHING_DUE", "Nothing on the compliance calendar is due within 14 days", null, null);
    return { title: `Post ${ids.length} compliance reminders to ${i.channel ?? "#payroll"}`, diff: [], content: [{ label: "Message", text }], moneyCents: null, subjectRef: `calendar:${ptDateOf(ctx.now)}`,
      subjectHash: sha256Hex(canonicalJson({ ids, text })), evidence: ids.slice(0, 10).map((id) => ({ label: "Calendar row", ref: id })) };
  },
  async run(i, ctx, deps) {
    const { text, ids } = await reminderText(deps.tx, ctx.companyId, ptDateOf(ctx.now));
    if (!text) throw new DomainRefusal("DOMAIN_NOTHING_DUE", "Nothing on the compliance calendar is due within 14 days", null, null);
    const channel = i.channel ?? "#payroll";
    const { id } = await deps.sims.chat.post({ channel, author: "Weft agent", text });
    return { data: { channel, message_id: id, item_ids: ids, count: ids.length }, summary: `Posted ${ids.length} compliance reminders to ${channel}` };
  },
});

// ---------------------------------------------------------------- notice upload (T4)
//
// A person uploads a scan of a mailed notice. notices.upload stores the file and a placeholder notice (source upload);
// the svc_events handler on notice.uploaded runs notices.ingest_upload, which reads the sidecar JSON for those bytes
// (packages/sim/src/notices/mailed, no OCR and no model call). An unreadable file, a confidence under 0.9 or a kind
// Weft does not handle opens a tax specialist hand-off in code. Everything else is left to rt_compliance_uploads,
// whose runs start tainted, so nothing an upload says can drive a write without a person's approval.

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "notice";
const UploadInput = z.object({
  upload_id: z.string().startsWith("upl_").optional(),
  file_name: z.string().min(1).max(200).optional(), bytes: z.number().int().positive().max(5 * 1024 * 1024).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), storage_path: z.string().max(200).optional(),
  agency_hint: z.string().max(40).nullable().optional(),
}).strict();
type UploadInput = z.infer<typeof UploadInput>;

export const uploadNoticeCmd = writeCommand<UploadInput>({
  name: "notices.upload", summary: "A person uploads a mailed agency notice (human only).",
  description: "Human only: store a scan of a mailed agency notice (a new file, or upload_id of an existing upload) as a notice with source upload. Its fields are read from the scan by notices.ingest_upload; the text is untrusted.",
  // approval "always" (the planned table says never): harness 5.4 requires approval for every R2 notices.* command.
  // Access is human_only and a human session executes directly, so the person's upload is never a proposal.
  input: UploadInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "always", access: "human_only", reversible: false,
  async preview(i) {
    const name = safeName(i.file_name ?? i.upload_id ?? "notice");
    return { title: `Store the uploaded notice ${name}`, diff: [], content: [], moneyCents: null, subjectRef: i.upload_id ?? i.sha256 ?? name, subjectHash: sha256Hex(canonicalJson(i)), evidence: [] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    let up: typeof uploads.$inferSelect | undefined;
    if (i.upload_id) {
      [up] = await tx.select().from(uploads).where(eq(uploads.id, i.upload_id)).limit(1);
      if (!up) throw notFound("upload", i.upload_id);
    } else {
      if (!i.file_name || !i.bytes || !i.sha256 || !i.storage_path) throw new DomainRefusal("DOMAIN_UPLOAD_INCOMPLETE", "Send upload_id, or file_name, bytes, sha256 and storage_path", null, null);
      const [p] = await tx.select({ workerId: principals.workerId }).from(principals).where(eq(principals.id, ctx.principal.id)).limit(1);
      const id = await deps.newId("upl_");
      // uploads.worker_id is required; an admin with no worker record is stored by principal id.
      up = { id, workerId: p?.workerId ?? ctx.principal.id, purpose: "agency_notice", fileName: safeName(i.file_name), storagePath: i.storage_path, bytes: i.bytes, sha256: i.sha256, createdAt: ctx.now };
      await tx.insert(uploads).values(up);
    }
    const prior = (await tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.source, "upload"))))
      .find((n) => n.uploadId === up!.id);
    if (prior) return { data: { notice_id: prior.id, upload_id: up.id, duplicate: true, status: prior.status }, summary: `${up.fileName} is already notice ${prior.id}` };
    const hint = i.agency_hint && AgencyCode.safeParse(i.agency_hint).success ? i.agency_hint : "unknown";
    const id = await deps.newId("ntc_");
    await tx.insert(notices).values({
      id, companyId: ctx.companyId, agency: hint, kind: "unclassified", formCode: "", title: "Uploaded notice (being read)", receivedAt: ctx.now, respondBy: null,
      status: "new", taxAccountId: null, fileName: safeName(up.fileName), bodyText: "", extractedJson: null, draftsJson: "[]", resolutionJson: null, responseConfirmation: null,
      source: "upload", uploadId: up.id,
    });
    return {
      data: { notice_id: id, upload_id: up.id, status: "new", file_name: safeName(up.fileName) },
      summary: `Uploaded ${safeName(up.fileName)} as notice ${id}`,
      events: [{ type: "notice.uploaded", subjectRef: id, payload: { notice_id: id, upload_id: up.id } }],
    };
  },
});

/** The stored extract, including the confidence the shared NoticeExtract schema strips. */
export function uploadConfidence(extractedJson: string | null): number | null {
  if (!extractedJson) return null;
  try { const v = JSON.parse(extractedJson) as { confidence?: unknown }; return typeof v.confidence === "number" ? v.confidence : null; } catch { return null; }
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s-]/g, "");

export const ingestUploadCmd = writeCommand<{ notice_id: string }>({
  name: "notices.ingest_upload", summary: "System: read an uploaded notice's fields from its scan sidecar.",
  description: "System command (svc_events on notice.uploaded): reads the uploaded file's sidecar JSON (no OCR, no model call), stores the kind, form, dates, amounts and a confidence, matches the tax account, and hands an unreadable, uncertain or unknown notice to a tax specialist.",
  input: z.object({ notice_id: z.string().startsWith("ntc_") }).strict(), domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const [n] = await tx.select().from(notices).where(and(eq(notices.companyId, ctx.companyId), eq(notices.id, i.notice_id))).limit(1);
    if (!n) throw notFound("notice", i.notice_id);
    if (n.source !== "upload" || !n.uploadId) throw new DomainRefusal("DOMAIN_NOT_UPLOADED", `${n.id} was not uploaded`, null, null);
    if (n.kind !== "unclassified") return { data: { notice_id: n.id, kind: n.kind, already: true }, summary: `${n.id} was already read` };
    const [up] = await tx.select().from(uploads).where(eq(uploads.id, n.uploadId)).limit(1);
    const found = up ? extractUpload(up.sha256) : null;
    const ex = found?.extract ?? null;
    let taxAccountId: string | null = null;
    if (ex?.accountNumber) {
      const accts = await tx.select().from(taxAccounts).where(eq(taxAccounts.companyId, ctx.companyId));
      taxAccountId = accts.find((a) => a.agency === ex.agency && norm(a.accountNumber) === norm(ex.accountNumber))?.id ?? null;
    }
    const known = !!ex && AgencyNoticeKind.safeParse(ex.kind).success && AgencyCode.safeParse(ex.agency).success;
    const extracted = ex ? { agency: ex.agency, formCode: ex.formCode, kind: ex.kind, accountNumber: ex.accountNumber, taxAccountId, taxYear: ex.taxYear, effectiveFrom: ex.effectiveFrom,
      respondBy: ex.respondBy, rates: [], amountCents: ex.amountCents, period: ex.period, confidence: ex.confidence, sample: found!.sample } : null;
    await tx.update(notices).set({
      kind: ex?.kind ?? "unreadable", agency: ex?.agency ?? n.agency, formCode: ex?.formCode ?? "", title: ex?.title ?? "Uploaded notice (could not be read)",
      respondBy: ex?.respondBy ?? null, taxAccountId, bodyText: found?.text ?? "", extractedJson: extracted ? JSON.stringify(extracted) : null,
    }).where(eq(notices.id, n.id));
    const { plan, reason } = planNotice({ kind: ex?.kind ?? "unreadable", extract: ex ? { formCode: ex.formCode, period: ex.period, effectiveFrom: ex.effectiveFrom, accountNumber: ex.accountNumber, confidence: ex.confidence } : null, taxAccountId, filing: null, source: "upload" });
    const toPerson = plan === "escalate" && (reason === "unknown_notice_kind" || reason === "low_confidence_extract");
    let handoffId: string | null = null;
    if (toPerson || !known) {
      const why = !ex ? "Weft could not read the uploaded file: it matches no scan on record." : reason === "low_confidence_extract" ? `The fields read from the scan are uncertain (confidence ${Math.round(ex.confidence * 100)} percent, under ${Math.round(MIN_EXTRACT_CONFIDENCE * 100)}).` : `The uploaded notice is a kind Weft does not handle (${ex.kind.replaceAll("_", " ")}, form ${ex.formCode || "unknown"}).`;
      const r = await createHandoff(deps, ctx.companyId, ctx.now, { kind: "tax_specialist", reason: !ex || reason === "low_confidence_extract" ? "low_confidence_extract" : "unknown_notice_kind", subjectRef: n.id, workerId: null, summary: why, openedBy: ctx.principal.id, runId: null });
      handoffId = r.id;
    }
    return {
      data: { notice_id: n.id, read: !!ex, kind: ex?.kind ?? null, confidence: ex?.confidence ?? null, tax_account_id: taxAccountId, plan, handoff_id: handoffId },
      summary: ex ? `Read uploaded notice ${n.id}: ${ex.kind}, confidence ${ex.confidence}${handoffId ? `, handed to a tax specialist as ${handoffId}` : ""}` : `Uploaded notice ${n.id} could not be read; handed to a tax specialist as ${handoffId}`,
      events: handoffId ? [{ type: "handoff.opened", subjectRef: handoffId, payload: { handoff_id: handoffId } }] : [],
    };
  },
});

// ---------------------------------------------------------------- required training (T11)

const ListTrainingInput = z.object({ worker_id: z.string().startsWith("wrk_").optional(), status: z.enum(["assigned", "reminded", "completed", "overdue", "waived"]).optional(), course_code: TrainingCourseCode.optional(), ...responseFormatField });
type ListTrainingInput = z.infer<typeof ListTrainingInput>;
const listTrainingCmd = readCommand({
  name: "training.list_assignments", domain: "people",
  summary: "Required training: assignments by person and course, and who still needs one.",
  description: "List required training assignments (California, New York and Illinois harassment prevention) with worker, course, due date, days left and status (assigned, reminded, completed, overdue). Also lists who needs a new assignment (a new hire or a cycle coming due) with the derived due date. Filter by worker_id, status or course_code.",
  input: ListTrainingInput,
  async run(i: ListTrainingInput, ctx, deps) {
    const today = ptDateOf(ctx.now);
    const scope = await readScopeOf(deps.tx, ctx);
    const { shown: rows, withheld } = splitByScope(scope, await listAssignments(deps.tx, ctx.companyId, today, { workerId: i.worker_id, status: i.status, courseCode: i.course_code }), (a) => a.workerId);
    const missing = splitByScope(scope, i.worker_id || i.status || i.course_code ? [] : await missingAssignments(deps.tx, ctx.companyId, today), (m) => m.worker_id).shown;
    const items = rows.map((a) => ({ id: a.id, worker_id: a.workerId, worker: a.workerName, course_code: a.courseCode, due_on: a.dueOn, days_left: a.daysLeft, status: a.status,
      ...(isDetailed(i) ? { course: a.courseTitle, minutes: a.minutes, reminded_at: a.remindedAt, completed_at: a.completedAt, certificate_upload_id: a.certificateUploadId, source_url: a.sourceUrl } : {}) }));
    const access = scope && withheld ? { access: reportsAccess(scope, "training assignments", withheld) } : {};
    return { data: { as_of: today, count: items.length, assignments: items, needs_assignment: missing, ...access }, summary: `Listed ${items.length} training assignments; ${missing.length} people need one` };
  },
});

const AssignInput = z.object({
  assignments: z.array(z.object({ worker_id: z.string().startsWith("wrk_"), course_code: TrainingCourseCode, due_on: isoDate }).strict()).min(1).max(25),
}).strict();
type AssignInput = z.infer<typeof AssignInput>;

async function checkAssign(i: AssignInput, ctx: { companyId: string; now: string }, tx: DbTx) {
  const today = ptDateOf(ctx.now);
  const rows: { worker_id: string; name: string; email: string; course_code: string; title: string; due_on: string }[] = [];
  for (const a of i.assignments) {
    const [w] = await tx.select().from(workers).where(and(eq(workers.companyId, ctx.companyId), eq(workers.id, a.worker_id))).limit(1);
    if (!w) throw notFound("worker", a.worker_id);
    const rule = RULE_BY_CODE[a.course_code];
    if (!rule || rule.jurisdiction !== w.workState) throw new DomainRefusal("DOMAIN_NOT_REQUIRED", `${a.course_code} is not required for ${w.firstName} ${w.lastName} (works in ${w.workState ?? "no state"})`, "Use training.list_assignments needs_assignment", null);
    if (a.due_on < today) throw new DomainRefusal("DOMAIN_DUE_IN_PAST", `The due date ${a.due_on} is before today ${today}`, null, null);
    rows.push({ worker_id: w.id, name: `${w.firstName} ${w.lastName}`, email: w.workEmail, course_code: a.course_code, title: rule.title, due_on: a.due_on });
  }
  return rows;
}

export const assignTrainingCmd = writeCommand<AssignInput>({
  name: "training.assign", summary: "Assign required training and email each person (R3, always approved).",
  description: "Assign required harassment prevention training: assignments of worker_id, course_code and due_on (from training.list_assignments needs_assignment). Emails each person the course and due date. R3: always a proposal for the agent. Example: {\"assignments\":[{\"worker_id\":\"wrk_0003\",\"course_code\":\"ca_harassment_staff\",\"due_on\":\"2027-01-15\"}]}",
  input: AssignInput, domain: "people", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false, lease: () => "training:assign",
  async preview(i, ctx, deps) {
    const rows = await checkAssign(i, ctx, deps.tx);
    return {
      title: `Assign ${rows.length} required training course${rows.length === 1 ? "" : "s"}`,
      diff: rows.map((r) => ({ label: `${r.name}: ${r.title}`, before: "not assigned", after: `due ${r.due_on}` })), content: [], moneyCents: null, subjectRef: "training",
      subjectHash: sha256Hex(canonicalJson(rows.map((r) => [r.worker_id, r.course_code, r.due_on]))), evidence: rows.map((r) => ({ label: "Statute", ref: RULE_BY_CODE[r.course_code]!.sourceUrl })).slice(0, 4),
    };
  },
  async run(i, ctx, deps) {
    const rows = await checkAssign(i, ctx, deps.tx);
    const courses = await ensureCourses(deps.tx, ctx.companyId, (p) => deps.newId(p as never));
    const ids: string[] = [];
    for (const r of rows) {
      const c = courses.get(r.course_code)!;
      const open = (await deps.tx.select().from(trainingAssignments).where(and(eq(trainingAssignments.workerId, r.worker_id), eq(trainingAssignments.courseId, c.id))))
        .find((a) => a.status !== "completed" && a.status !== "waived");
      if (open) { ids.push(open.id); continue; }
      const id = await deps.newId("tra_");
      await deps.tx.insert(trainingAssignments).values({ id, workerId: r.worker_id, courseId: c.id, dueOn: r.due_on, status: "assigned", assignedAt: ctx.now, remindedAt: null, completedAt: null, certificateUploadId: null, proposalId: ctx.approvedProposalId ?? null });
      await deps.sims.email.send({ to: r.email, from: "people@larkspur.example", subject: `Required training: ${r.title}`, body: `Hi ${r.name.split(" ")[0]},\n\nPlease complete ${r.title} by ${r.due_on}. Open the Training section of your Weft portal to start and to record completion.\n\n(sent by Weft; demo)`, kind: "generic", relatedRef: id });
      ids.push(id);
    }
    return {
      data: { assignment_ids: ids, count: ids.length },
      summary: `Assigned ${ids.length} required training course${ids.length === 1 ? "" : "s"}`,
      events: ids.map((id, k) => ({ type: "training.assigned", subjectRef: id, payload: { assignment_id: id, worker_id: rows[k]!.worker_id } })),
    };
  },
});

async function reminderRows(tx: DbTx, companyId: string, today: string) {
  return (await listAssignments(tx, companyId, today)).filter((a) => (a.status === "assigned" || a.status === "reminded" || a.status === "overdue") && a.daysLeft <= 14
    && (!a.remindedAt || a.remindedAt.slice(0, 10) <= addDays(today, -7)));
}

export const sendTrainingRemindersCmd = writeCommand<Record<string, never>>({
  name: "training.send_reminders", summary: "Email reminders for training due within 14 days or overdue (R3).",
  description: "Email each person whose required training is due within 14 days or overdue, at most once a week per assignment. The email text is written in code. R3: always a proposal for the agent.",
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>, domain: "people", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false, lease: () => "training:remind",
  async preview(_i, ctx, deps) {
    const rows = await reminderRows(deps.tx, ctx.companyId, ptDateOf(ctx.now));
    if (!rows.length) throw new DomainRefusal("DOMAIN_NOTHING_DUE", "No required training is due within 14 days", null, null);
    return { title: `Email ${rows.length} training reminder${rows.length === 1 ? "" : "s"}`, diff: rows.map((a) => ({ label: `${a.workerName}: ${a.courseTitle}`, before: a.status, after: `reminded (due ${a.dueOn})` })),
      content: [], moneyCents: null, subjectRef: "training", subjectHash: sha256Hex(canonicalJson(rows.map((a) => a.id))), evidence: rows.slice(0, 10).map((a) => ({ label: "Assignment", ref: a.id })) };
  },
  async run(_i, ctx, deps) {
    const rows = await reminderRows(deps.tx, ctx.companyId, ptDateOf(ctx.now));
    for (const a of rows) {
      const [w] = await deps.tx.select({ email: workers.workEmail, first: workers.firstName }).from(workers).where(eq(workers.id, a.workerId)).limit(1);
      if (w) await deps.sims.email.send({ to: w.email, from: "people@larkspur.example", subject: `Reminder: ${a.courseTitle} ${a.status === "overdue" ? "is overdue" : `is due ${a.dueOn}`}`, body: `Hi ${w.first},\n\n${a.courseTitle} ${a.status === "overdue" ? `was due on ${a.dueOn}` : `is due on ${a.dueOn}`}. Open the Training section of your Weft portal to finish it.\n\n(sent by Weft; demo)`, kind: "generic", relatedRef: a.id });
      await deps.tx.update(trainingAssignments).set({ status: "reminded", remindedAt: ctx.now }).where(eq(trainingAssignments.id, a.id));
    }
    return { data: { reminded: rows.map((a) => a.id), count: rows.length }, summary: `Sent ${rows.length} training reminder${rows.length === 1 ? "" : "s"}` };
  },
});

const CompleteInput = z.object({
  assignment_id: z.string().startsWith("tra_"), certificate_upload_id: z.string().startsWith("upl_").optional(),
  certificate: z.object({ file_name: z.string().min(1).max(200), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), storage_path: z.string().max(200) }).strict().optional(),
}).strict();
type CompleteInput = z.infer<typeof CompleteInput>;
export const completeTrainingCmd = writeCommand<CompleteInput>({
  name: "training.complete", summary: "A person records finishing required training, with a certificate (human only).",
  description: "Human only: the employee (or an admin) records an assignment as completed, with a certificate upload or the certificate Weft issues on completion.",
  input: CompleteInput, domain: "people", needs: "edit", effect: "write", risk: riskOf("R2"), approval: "never", access: "human_only", reversible: false, preview: null,
  async run(i, ctx, deps) {
    const a = await getAssignment(deps.tx, i.assignment_id);
    if (!a) throw notFound("training assignment", i.assignment_id);
    const [p] = await deps.tx.select({ role: principals.role, workerId: principals.workerId }).from(principals).where(eq(principals.id, ctx.principal.id)).limit(1);
    const admin = p?.role === "admin" || p?.role === "hr_manager";
    if (!admin && p?.workerId !== a.workerId) throw new DomainRefusal("DOMAIN_NOT_ASSIGNEE", "Only the person assigned, or an admin, records completion", null, null);
    if (a.status === "completed") return { data: { assignment_id: a.id, status: "completed", already: true, certificate_upload_id: a.certificateUploadId }, summary: `${a.id} is already completed` };
    let cert = i.certificate_upload_id ?? null;
    if (!cert && i.certificate) {
      cert = await deps.newId("upl_");
      await deps.tx.insert(uploads).values({ id: cert, workerId: a.workerId, purpose: "training_certificate", fileName: safeName(i.certificate.file_name), storagePath: i.certificate.storage_path, bytes: i.certificate.bytes, sha256: i.certificate.sha256, createdAt: ctx.now });
    }
    await deps.tx.update(trainingAssignments).set({ status: "completed", completedAt: ctx.now, certificateUploadId: cert }).where(eq(trainingAssignments.id, a.id));
    return {
      data: { assignment_id: a.id, status: "completed", completed_at: ctx.now, certificate_upload_id: cert },
      summary: `Recorded training ${a.id} as completed`,
      events: [{ type: "training.completed", subjectRef: a.id, payload: { assignment_id: a.id, worker_id: a.workerId } }],
    };
  },
});

export const w4ComplianceCommands: WeftCommand[] = [
  postRemindersCmd,
  calendarCmd, refreshCalendarCmd, listFilingsCmd, getFilingCmd, prepareFilingCmd, fileReturnCmd,
  listHandoffsCmd, openHandoffCmd, resolveHandoffCmd, setDepositScheduleCmd, acknowledgeNoticeCmd,
  uploadNoticeCmd, ingestUploadCmd, listTrainingCmd, assignTrainingCmd, sendTrainingRemindersCmd, completeTrainingCmd,
];
