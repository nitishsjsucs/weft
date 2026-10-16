"use client";
// Add an expense for an employee (owner: w3-expenses). The claim goes through expenses.submit as the signed-in person;
// the policy engine runs at once and the item lands in Needs review with its checks. Mileage shows the amount the IRS
// rate on the trip date gives, and that amount is what is claimed. A receipt file goes as multipart on the I-9 upload path.
import { useMemo, useState } from "react";
import { Button, Drawer } from "@weft/ui/components";
import { EXPENSE_RATES, ExpenseCategory, W3_EXPENSES_TID as TID, type ToolOutcome, type Worker } from "@weft/contracts";
import { ApiError } from "@/lib/api/client";
import { client, errorText, getPrincipal, rawFetch, useGet, useMutation } from "@/lib/api/hooks";
import { CATEGORY_LABEL, usd } from "./labels";

const field = "h-8 w-full rounded-lg bg-card px-2.5 text-[13px] shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
const rateOn = (d: string) => EXPENSE_RATES.mileageCentsPerMileX10.find((r) => r.from <= d && d <= r.to)?.centsPerMileX10 ?? null;
const toCents = (s: string) => { const m = /^\s*\$?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(s); return m ? Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")) : null; };
const toMilesX10 = (s: string) => { const m = /^\s*(\d{1,5})(?:\.(\d))?\s*$/.exec(s); return m ? Number(m[1]) * 10 + Number(m[2] ?? "0") : null; };

export function AddExpense({ open, onClose, today }: { open: boolean; onClose: () => void; today: string }) {
  const ws = useGet("/v1/workers", { query: { type: "employee", limit: 100 }, enabled: open });
  const workers = ((ws.data?.data ?? []) as Worker[]).filter((w) => w.status !== "inactive");
  const [f, setF] = useState({ workerId: "", category: "travel", merchant: "", amount: "", date: today, purpose: "", attendees: "", miles: "" });
  const [done, setDone] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const milesX10 = f.category === "mileage" ? toMilesX10(f.miles) : null;
  const rate = rateOn(f.date);
  const amountCents = useMemo(() => (f.category === "mileage" ? (milesX10 !== null && rate !== null ? Math.floor((milesX10 * rate + 50) / 100) : null) : toCents(f.amount)), [f.category, f.amount, milesX10, rate]);
  const ok = !!f.workerId && f.merchant.trim() && f.purpose.trim() && amountCents !== null && amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(f.date);
  const submit = useMutation(async (): Promise<ToolOutcome> => {
    const body = {
      workerId: f.workerId, category: f.category, merchant: f.merchant.trim(), amountCents, transactionDate: f.date, businessPurpose: f.purpose.trim(),
      attendees: f.category === "meals" && f.attendees.trim() ? f.attendees.trim() : null, milesX10: f.category === "mileage" ? milesX10 : null,
    };
    if (!file) return (await client.post("/v1/expenses", { body })) as ToolOutcome;
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) fd.set(k, String(v));
    fd.set("receipt", file, file.name);
    const res = await rawFetch("/api/v1/expenses", { method: "POST", headers: { accept: "application/json", "x-weft-principal": getPrincipal() }, body: fd });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json ?? { _tag: "Internal", message: res.statusText });
    return json as ToolOutcome;
  });
  const go = async () => {
    const o = await submit.run();
    if (o?.ok && o.status === "done") { setDone(o.summary); setF((x) => ({ ...x, merchant: "", amount: "", purpose: "", attendees: "", miles: "" })); setFile(null); setFileKey((k) => k + 1); }
  };
  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) { setDone(null); onClose(); } }} title="Add an expense" description="The policy checks run as soon as it is saved.">
      <div className="flex flex-col gap-3 text-[13px]">
        {submit.error ? <div role="alert" className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(submit.error)}</div> : null}
        {done ? <div role="status" className="rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{done}. It is in Needs review.</div> : null}
        <label className="flex flex-col gap-1">Employee
          <select className={field} value={f.workerId} onChange={set("workerId")}>
            <option value="">Choose a person</option>
            {workers.map((w) => <option key={w.id} value={w.id}>{w.displayName}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Category
            <select className={field} value={f.category} onChange={set("category")}>{ExpenseCategory.options.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1">Date<input className={field} type="date" value={f.date} max={today} onChange={set("date")} /></label>
        </div>
        <label className="flex flex-col gap-1">Merchant<input className={field} value={f.merchant} maxLength={120} onChange={set("merchant")} /></label>
        {f.category === "mileage" ? (
          <label className="flex flex-col gap-1">Miles driven
            <input className={field} inputMode="decimal" value={f.miles} onChange={set("miles")} placeholder="84.0" />
            <span className="text-1 text-gray-10">{rate === null ? "No published mileage rate for that date." : `${(rate / 10).toFixed(1)} cents a mile on ${f.date}${amountCents !== null ? `: ${usd(amountCents)}` : ""}`}</span>
          </label>
        ) : (
          <label className="flex flex-col gap-1">Amount<input className={field} inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="0.00" /></label>
        )}
        <label className="flex flex-col gap-1">Business purpose<input className={field} value={f.purpose} maxLength={400} onChange={set("purpose")} /></label>
        {f.category === "meals" ? <label className="flex flex-col gap-1">Attendees<input className={field} value={f.attendees} maxLength={400} onChange={set("attendees")} placeholder="Names, separated by commas" /></label> : null}
        <label className="flex flex-col gap-1">Receipt
          <input key={fileKey} type="file" className="text-1 text-gray-11 file:mr-3 file:h-7 file:cursor-pointer file:rounded-lg file:border-0 file:bg-card file:px-2.5 file:text-[13px] file:text-foreground file:shadow-[var(--shadow-border)]" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="text-1 text-gray-10">PNG, JPEG, WebP or PDF up to 5 MB. Lodging always needs one; other claims need one at $75 or more.</span>
        </label>
        <Button data-testid={TID.submit} variant="primary" size="sm" className="self-start" disabled={!ok || submit.pending} onClick={() => void go()}>Save expense</Button>
      </div>
    </Drawer>
  );
}
