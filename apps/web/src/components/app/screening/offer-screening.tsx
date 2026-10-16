"use client";
// Background check status for one offer in the hiring view (w3-integrations-screening-esign). Shows status, result,
// ETA and timestamps only. Review and every adverse step are buttons for a person; the agent never sees them, and
// opening the report items is audited (screening.review).
import { useState } from "react";
import { Badge, Button } from "@weft/ui/components";
import { formatCents } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { fmtDate } from "../format";

interface View {
  id: string; offerId: string; vendor: string; mode: "simulated" | "real"; packageName: string; priceCents: number; phase: string; status: string; result: string | null;
  adjudication: string; timerPaused: boolean; etaOn: string | null; createdAt: string; completedAt: string | null; reviewRequired: boolean; nextSteps: string[];
}
const LABEL: Record<string, string> = {
  invited: "Invited", consented: "Consented", in_progress: "In progress", suspended: "Needs information", disputed: "Disputed", complete_clear: "Clear",
  complete_review: "Review required", canceled: "Canceled", expired: "Expired",
};
/** The screening company, by name only. HireRight publishes no public API shape, so its simulator says so. */
const VENDOR: Record<string, string> = { checkr: "Checkr", hireright: "HireRight" };
const simLabel = (vendor: string) => (vendor === "hireright" ? "Simulated, API shape not published" : "Simulated");
const TONE: Record<string, "gray" | "blue" | "green" | "amber"> = { complete_clear: "green", complete_review: "amber", suspended: "amber", disputed: "amber", invited: "blue", consented: "blue", in_progress: "blue" };
const STEP: Record<string, { label: string; variant: "primary" | "secondary" | "danger" }> = {
  engage: { label: "Proceed with hire", variant: "primary" }, pre_adverse: { label: "Start pre-adverse notice", variant: "danger" },
  final_adverse: { label: "Record final decision", variant: "danger" }, cancel_adverse: { label: "Withdraw notice", variant: "secondary" },
  proceed_to_criminal: { label: "Proceed to criminal check", variant: "primary" },
};

export function OfferScreening({ offerId, accepted }: { offerId: string; accepted: boolean }) {
  const q = useGet("/v1/screening/orders", { query: { offerId, limit: 10 }, refreshMs: 5_000, enabled: accepted });
  const order = useMutation(async () => client.post("/v1/offers/:id/screening", { params: { id: offerId }, body: {} }));
  if (!accepted) return null;
  const rows = ((q.data as { data?: View[] } | undefined)?.data ?? []) as View[];
  return (
    <div data-testid="offer-screening" className="w-full rounded-lg bg-gray-2 px-3 py-2 text-1">
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-gray-11">Background check: not ordered. The screening company collects consent from the new hire.</span>
          <Button size="sm" variant="secondary" data-testid="offer-screening-order" disabled={order.pending} onClick={() => void order.run()}>Order background check</Button>
        </div>
      ) : rows.map((r) => <OrderLine key={r.id} r={r} />)}
      {order.error ? <p role="alert" className="mt-1 text-red-11">{errorText(order.error)}</p> : null}
    </div>
  );
}

function OrderLine({ r }: { r: View }) {
  const [items, setItems] = useState<{ id: string; text: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const step = useMutation(async (s: string) => client.post("/v1/screening/orders/:id/adjudicate", { params: { id: r.id }, body: { step: s } }));
  const open = async () => {
    try { const v = (await client.get("/v1/screening/orders/:id", { params: { id: r.id }, query: { detail: "items" } })) as unknown as { items?: { id: string; text: string }[] }; setItems(v.items ?? []); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <div data-testid="offer-screening-order-row" data-status={r.status} className="flex flex-col gap-1 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-gray-12">Background check</span>
        <Badge data-testid="offer-screening-status" data-status={r.status} tone={TONE[r.status] ?? "gray"}>{LABEL[r.status] ?? r.status}</Badge>
        <span data-testid="offer-screening-vendor" className="text-gray-11">with {VENDOR[r.vendor] ?? r.vendor}</span>
        {r.mode === "simulated" ? <Badge tone="gray" data-testid="offer-screening-mode">{simLabel(r.vendor)}</Badge> : null}
        <span className="text-gray-10">{r.packageName}, {formatCents(r.priceCents)}{r.phase !== "full" ? ` (${r.phase.replace("_", "-")} phase)` : ""}{r.etaOn ? ` · ETA ${fmtDate(r.etaOn)}` : ""}{r.completedAt ? ` · done ${fmtDate(r.completedAt.slice(0, 10))}` : ""}</span>
        {r.adjudication !== "none" ? <span className="text-gray-11">· {r.adjudication.replace("_", "-")}{r.timerPaused ? " (paused)" : ""}</span> : null}
      </div>
      {r.reviewRequired || r.nextSteps.length ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="offer-screening-human-steps">
          <span className="text-gray-11">For a person only:</span>
          {r.reviewRequired ? <Button size="sm" variant="secondary" data-testid="offer-screening-review" onClick={() => void open()}>Open report</Button> : null}
          {r.nextSteps.map((s) => <Button key={s} size="sm" variant={STEP[s]?.variant ?? "secondary"} data-testid={`offer-screening-step-${s}`} disabled={step.pending} onClick={() => void step.run(s)}>{STEP[s]?.label ?? s}</Button>)}
        </div>
      ) : null}
      {items ? <ul className="rounded border border-[var(--app-border)] bg-card p-2" data-testid="offer-screening-items">{items.map((x) => <li key={x.id} className="whitespace-pre-wrap">{x.text}</li>)}</ul> : null}
      {err || step.error ? <p role="alert" className="text-red-11">{err ?? errorText(step.error)}</p> : null}
    </div>
  );
}
