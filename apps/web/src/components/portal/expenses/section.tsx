"use client";
// Portal section (wave 3, docs/wave3.md). Owner: w3-expenses. My expenses: the signed-in person's own claims with their
// status, the approver's note on a returned item and where each one is paid, plus the submit form (category fields:
// attendees for meals, miles for mileage with the amount the IRS rate gives) with an optional receipt on the I-9 upload
// path. Calls go to /v1/portal/expenses* as the portal principal (the new hire persona reaches only /v1/portal/*).
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { EXPENSE_RATES, ExpenseCategory, W3_EXPENSES_TID as TID } from "@weft/contracts";
import { Receipt } from "lucide-react";
import type { W3ExpensesPortalPage, W3ExpensesPortalRow } from "../../../../../../packages/contracts/src/ext/w3-expenses";
import { CATEGORY_LABEL, RULE_LABEL, STATUS_LABEL, STATUS_TONE, usd } from "../../app/expenses/labels";
import { fmtDate } from "../../app/format";

const field = "h-9 w-full rounded-lg border border-[var(--app-border)] bg-card px-3 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
const rateOn = (d: string) => EXPENSE_RATES.mileageCentsPerMileX10.find((r) => r.from <= d && d <= r.to)?.centsPerMileX10 ?? null;
const toCents = (s: string) => { const m = /^\s*\$?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")) : null; };
const toMilesX10 = (s: string) => { const m = /^\s*(\d{1,5})(?:\.(\d))?\s*$/.exec(s); return m ? Number(m[1]) * 10 + Number(m[2] ?? "0") : null; };
const dollars = (c: number) => (c / 100).toFixed(2);

type Form = { category: string; merchant: string; amount: string; date: string; purpose: string; attendees: string; miles: string };
const EMPTY: Form = { category: "travel", merchant: "", amount: "", date: "", purpose: "", attendees: "", miles: "" };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex flex-col gap-1 text-1 text-gray-11">{label}{children}{hint ? <span className="text-gray-10">{hint}</span> : null}</label>;
}

export function ExpensesPortalSection({ principal }: { workerId: string; principal: string }) {
  const [page, setPage] = useState<W3ExpensesPortalPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState<W3ExpensesPortalRow | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const headers = useMemo(() => ({ "x-weft-principal": principal, accept: "application/json" }), [principal]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/portal/expenses", { headers });
      if (res.ok) setPage((await res.json()) as W3ExpensesPortalPage);
    } catch { /* the list stays as it was */ }
  }, [headers]);
  useEffect(() => { void load(); }, [load]);

  const send = async (fd: FormData, expenseId: string | null) => {
    setError(null); setDone(null);
    const res = await fetch(expenseId ? `/api/v1/portal/expenses/${expenseId}/resubmit` : "/api/v1/portal/expenses", { method: "POST", headers, body: fd });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; summary?: string; message?: string; issues?: { path: string; message: string }[]; extra?: { issues?: { path: string; message: string }[] } } | null;
    if (!res.ok || !body?.ok) {
      const issue = body?.issues?.[0] ?? body?.extra?.issues?.[0];
      setError(issue ? `${issue.path}: ${issue.message}` : body?.message ?? `The claim was not saved (${res.status})`);
      return false;
    }
    setDone(`${body.summary ?? "Saved"}. It is waiting for review.`);
    setOpen(false); setFixing(null);
    await load();
    return true;
  };

  if (!page?.workerId) return null;
  const rows = page.data;
  return (
    <section data-testid={TID.portal} className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <CardHeading icon={<Receipt />}>My expenses</CardHeading>
        {!open && !fixing ? <Button data-testid={TID.portalNew} variant="secondary" size="sm" onClick={() => { setOpen(true); setDone(null); }}>Submit an expense</Button> : null}
      </div>
      {done ? <div role="status" className="mb-3 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{done}</div> : null}
      {open || fixing ? (
        <Card className="mb-3 p-4">
          <ClaimForm key={fixing?.id ?? "new"} fixing={fixing} error={error} onCancel={() => { setOpen(false); setFixing(null); setError(null); }} onSubmit={(fd) => send(fd, fixing?.id ?? null)} />
        </Card>
      ) : null}
      {rows.length === 0 ? (
        <Card className="p-4 text-2 text-gray-11">No expenses yet. Claims you submit show here with their status and the pay date that reimburses them.</Card>
      ) : (
        <Card className="overflow-hidden">
          <Table className="text-[13px]">
            <THead><TR><TH>Date</TH><TH>Category</TH><TH numeric>Amount</TH><TH>Status</TH></TR></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id} data-testid={`portal-expense-${r.id}`} data-status={r.status}>
                  <TD className="h-10 whitespace-nowrap align-top">{fmtDate(r.transactionDate)}</TD>
                  <TD className="h-10 align-top">{CATEGORY_LABEL[r.category]}</TD>
                  <TD numeric className="h-10 whitespace-nowrap align-top">{usd(r.amountCents)}</TD>
                  <TD className="h-10 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      {r.payrollRunId ? <span className="text-1 text-gray-10">{r.status === "paid" ? "paid" : "pays"} on {r.payrollRunId}</span> : null}
                      {r.status === "needs_review" && r.checks.some((c) => c.severity !== "info") ? (
                        <span className="text-1 text-gray-10">{r.checks.filter((c) => c.severity !== "info").map((c) => RULE_LABEL[c.rule] ?? c.rule).join(", ")}</span>
                      ) : null}
                    </div>
                    {r.status === "returned" ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-1">
                        {/* The approver's note is plain text: rendered escaped, never as markup. */}
                        <span data-testid={TID.portalNote(r.id)} className="text-gray-12">{r.decisionNote ?? "Returned for changes."}</span>
                        <Button data-testid={TID.portalResubmit(r.id)} variant="secondary" size="sm" onClick={() => { setFixing(r); setOpen(false); setDone(null); }}>Fix and resubmit</Button>
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <p className="mt-2 text-1 text-gray-10">Reimbursements are paid with your regular pay, outside gross pay, so they are not taxed. Claims older than 60 days can only be paid as taxable wages.</p>
    </section>
  );
}

function ClaimForm({ fixing, error, onCancel, onSubmit }: { fixing: W3ExpensesPortalRow | null; error: string | null; onCancel: () => void; onSubmit: (fd: FormData) => Promise<boolean> }) {
  const [f, setF] = useState<Form>(() => fixing ? {
    category: fixing.category, merchant: fixing.merchant, amount: dollars(fixing.amountCents), date: fixing.transactionDate, purpose: fixing.businessPurpose,
    attendees: fixing.attendees ?? "", miles: fixing.milesX10 !== null ? (fixing.milesX10 / 10).toFixed(1) : "",
  } : EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const milesX10 = f.category === "mileage" ? toMilesX10(f.miles) : null;
  const rate = /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? rateOn(f.date) : null;
  const amountCents = f.category === "mileage" ? (milesX10 !== null && rate !== null ? Math.floor((milesX10 * rate + 50) / 100) : null) : toCents(f.amount);
  const ok = !!f.merchant.trim() && !!f.purpose.trim() && amountCents !== null && amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || amountCents === null) return;
    const fd = new FormData();
    fd.set("category", f.category); fd.set("merchant", f.merchant.trim()); fd.set("amountCents", String(amountCents)); fd.set("transactionDate", f.date); fd.set("businessPurpose", f.purpose.trim());
    if (f.category === "meals" && f.attendees.trim()) fd.set("attendees", f.attendees.trim());
    if (f.category === "mileage" && milesX10 !== null) fd.set("milesX10", String(milesX10));
    if (file) fd.set("receipt", file, file.name);
    setBusy(true);
    try { await onSubmit(fd); } finally { setBusy(false); }
  };
  return (
    <form data-testid={TID.portalForm} className="grid gap-4 tablet:grid-cols-2" onSubmit={(e) => void submit(e)}>
      <p className="text-2 font-medium text-gray-12 tablet:col-span-2">{fixing ? `Fix and resubmit ${fixing.id}` : "Submit an expense"}</p>
      {error ? <div role="alert" className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11 tablet:col-span-2">{error}</div> : null}
      <Field label="Category">
        <select data-testid={TID.portalField("category")} className={field} value={f.category} onChange={set("category")}>{ExpenseCategory.options.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
      </Field>
      <Field label="Date of the expense"><input data-testid={TID.portalField("date")} required className={field} type="date" value={f.date} onChange={set("date")} /></Field>
      <Field label={f.category === "mileage" ? "Where you drove" : "Merchant"}><input data-testid={TID.portalField("merchant")} required className={field} value={f.merchant} maxLength={120} onChange={set("merchant")} /></Field>
      {f.category === "mileage" ? (
        <Field label="Miles driven" hint={rate === null ? "Pick the date to see the mileage rate." : `${(rate / 10).toFixed(1)} cents a mile on ${f.date}${amountCents !== null ? `: ${usd(amountCents)}` : ""}`}>
          <input data-testid={TID.portalField("miles")} className={field} inputMode="decimal" value={f.miles} onChange={set("miles")} placeholder="84.0" />
        </Field>
      ) : (
        <Field label="Amount"><input data-testid={TID.portalField("amount")} className={field} inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="0.00" /></Field>
      )}
      <Field label="Business purpose"><input data-testid={TID.portalField("purpose")} required className={field} value={f.purpose} maxLength={400} onChange={set("purpose")} /></Field>
      {f.category === "meals" ? (
        <Field label="Who attended" hint="Names, separated by commas; meals need attendees and a purpose.">
          <input data-testid={TID.portalField("attendees")} className={field} value={f.attendees} maxLength={400} onChange={set("attendees")} />
        </Field>
      ) : null}
      <Field label="Receipt (PNG, JPEG, WebP or PDF, up to 5 MB)" hint={fixing?.hasReceipt ? "A receipt is already attached; a new file replaces it." : "Needed for lodging and for anything $75 or more."}>
        <input type="file" data-testid={TID.portalField("receipt")} className="text-1 text-gray-11 file:mr-3 file:h-8 file:cursor-pointer file:rounded-lg file:border file:border-[var(--app-border)] file:bg-card file:px-3 file:text-2 file:text-foreground" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <div className="flex items-center gap-2 tablet:col-span-2">
        <Button type="submit" data-testid={TID.portalSubmit} variant="primary" size="lg" disabled={!ok || busy}>{busy ? "Saving..." : fixing ? "Resubmit" : "Submit expense"}</Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
