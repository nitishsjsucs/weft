"use client";
// Expenses (wave 3, GP13). Owner: w3-expenses. Every claim in four bands (Needs review, Approved, Paid out, Declined)
// with counts, the policy checks on each row, and a drawer to decide one item at a time. Merchant and purpose are the
// employee's own text: React renders them as plain text, never markup.
import { useMemo, useState } from "react";
import { CircleCheck, CircleDashed, CircleX, Receipt } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { ExpenseBand, ExpenseCategory, W3_EXPENSES_TID as TID } from "@weft/contracts";
import type { W3ExpensesPage, W3ExpensesRow } from "../../../../../../packages/contracts/src/ext/w3-expenses";
import { client, errorText, useGet, useMutation, useSimClock } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { fmtDate } from "../format";
import { AddExpense } from "./add-expense";
import { ExpenseDrawer } from "./expense-drawer";
import { BAND_LABEL, CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, usd } from "./labels";

const BAND_ICON = { needs_review: <CircleDashed />, approved: <CircleCheck />, paid_out: <Receipt />, declined: <CircleX /> } as const;
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const SEVERITY_DOT = { block: "bg-red-9", review: "bg-amber-9", info: "bg-gray-8" } as const;

/** One dot for the strongest check (red blocks approval, amber needs judgment); the rules are in its title. */
function CheckDots({ row }: { row: W3ExpensesRow }) {
  const shown = row.checks.filter((c) => c.severity !== "info");
  if (!shown.length) return null;
  const top = shown.some((c) => c.severity === "block") ? "block" : "review";
  return <span role="img" aria-label={`Checks: ${shown.map((c) => c.rule).join(", ")}`} title={shown.map((c) => c.rule).join(", ")} className={`ml-1.5 inline-block size-1.5 rounded-full align-middle ${SEVERITY_DOT[top]}`} />;
}

export function ExpensesView() {
  const [category, setCategory] = useState<string>("");
  const [band, setBand] = useState<ExpenseBand | "">("");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useGet("/v1/expenses", { query: { limit: 100, category: category || undefined }, refreshMs: 10_000 });
  const page = q.data as W3ExpensesPage | undefined;
  const rows = useMemo(() => page?.data ?? [], [page]);
  const bands = ExpenseBand.options.filter((b) => !band || b === band);
  const clock = useSimClock();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const review = useMutation(async () => (await client.post("/v1/routines/:id/trigger", { params: { id: "rt_expense_review" }, body: {} })) as { routineRunId: string });
  const onReview = async () => { const r = await review.run(); if (r) setNotice("Review started: the agent explains each item and files one proposal per item in the Inbox."); };
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader
        title="Expenses"
        subtitle="Every claim is checked against the company policy as it arrives. Approvers decide one item at a time; approved items ride the next payroll, outside gross pay."
        meta={<Badge tone="outline" size="md">Synthetic data</Badge>}
        actions={<>
          <Button size="sm" variant="secondary" disabled={review.pending || !(page?.bands.needs_review)} onClick={() => void onReview()}>Review with agent</Button>
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add expense</Button>
        </>}
      />
      {notice ? <div role="status" className="mb-4 rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      {review.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(review.error)}</div> : null}
      {q.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(q.error)}</div> : null}
      <div className="mb-4 grid grid-cols-2 gap-2 tablet:grid-cols-4">
        {ExpenseBand.options.map((b) => (
          <button key={b} type="button" data-testid={TID.band(b)} data-count={page?.bands[b] ?? 0} aria-pressed={band === b}
            onClick={() => setBand(band === b ? "" : b)}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left shadow-[var(--shadow-border)] transition-colors [&_svg]:size-4 [&_svg]:text-gray-10 ${band === b ? "bg-gray-3" : "bg-card hover:bg-gray-2"}`}>
            {BAND_ICON[b]}
            <span className="text-[13px] text-gray-11">{BAND_LABEL[b]}</span>
            <span className="ml-auto text-3 font-semibold tabular">{page?.bands[b] ?? "-"}</span>
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <label className="flex items-center gap-2 text-gray-11">Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-7 rounded-md bg-card px-2 text-[13px] text-foreground shadow-[var(--shadow-border)]">
            <option value="">All</option>
            {ExpenseCategory.options.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </label>
        {band ? <button type="button" className="text-gray-10 hover:text-foreground" onClick={() => setBand("")}>Show all bands</button> : null}
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table data-testid={TID.table} className="text-[13px]">
            <THead><TR><TH>Employee</TH><TH className="hidden tablet:table-cell">Merchant</TH><TH>Category</TH><TH numeric>Amount</TH><TH className="hidden tablet:table-cell">Date</TH><TH>Status</TH></TR></THead>
            <TBody>
              {bands.map((b) => {
                const inBand = rows.filter((r) => r.band === b);
                return [
                  <TR key={`band-${b}`} className="bg-gray-2 hover:bg-gray-2">
                    <TD colSpan={6} className="h-8 text-1 font-medium tracking-wide text-gray-10 uppercase">{BAND_LABEL[b]} <span className="ml-1 tabular text-gray-9">{page?.bands[b] ?? inBand.length}</span></TD>
                  </TR>,
                  ...(inBand.length ? inBand.map((r) => (
                    <TR key={r.id} data-testid={TID.row(r.id)} data-tour="expense-row" data-band={r.band} data-checks={r.checks.some((c) => c.severity === "block") ? "red" : r.checks.some((c) => c.severity === "review") ? "amber" : "none"} data-status={r.status} className="cursor-pointer" onClick={() => setOpenId(r.id)}
                      tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(r.id); } }}>
                      <TD className="h-12 max-w-[200px]">
                        <div className="truncate font-medium" title={r.workerName}>{r.workerName}</div>
                        <div className="truncate text-1 text-gray-10" title={r.workerTitle}>{r.workerTitle}</div>
                      </TD>
                      <TD className="hidden h-12 max-w-[150px] truncate tablet:table-cell" title={r.merchant}>{r.merchant}</TD>
                      <TD className="h-12 whitespace-nowrap">{CATEGORY_LABEL[r.category]}{r.hasReceipt || r.category === "mileage" ? null : <span className="ml-1 text-1 text-gray-9">no receipt</span>}</TD>
                      <TD numeric className="h-12 whitespace-nowrap">{usd(r.amountCents)}</TD>
                      <TD className="hidden h-12 whitespace-nowrap tablet:table-cell">
                        <div>{fmtDate(r.transactionDate)}</div>
                        <div className="text-1 text-gray-10">submitted {fmtDate(r.submittedDate)}</div>
                      </TD>
                      <TD className="h-12 whitespace-nowrap"><Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge><CheckDots row={r} /></TD>
                    </TR>
                  )) : [<TR key={`empty-${b}`}><TD colSpan={6} className="h-9 text-gray-9">{q.data ? "Nothing here." : "Loading..."}</TD></TR>]),
                ];
              })}
            </TBody>
          </Table>
        </div>
      </Card>
      <p className="mt-2 text-1 text-gray-10">A dot marks policy checks: red blocks approval, amber needs a person&apos;s judgment. Receipts are simulated images with a simulated extraction.</p>
      <ExpenseDrawer id={openId} onClose={() => setOpenId(null)} />
      <AddExpense open={adding} onClose={() => setAdding(false)} today={clock.data ? ptDate(clock.data.now) : "2026-10-26"} />
    </div>
  );
}
