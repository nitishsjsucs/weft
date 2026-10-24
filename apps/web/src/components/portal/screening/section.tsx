"use client";
// Portal section (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. The new hire's background check: its
// status, and while the check is simulated, the screening company's apply page (simulated, labeled as such) with the
// disclosure, the summary of rights and the authorization. A real screening company hosts this page on its own site.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card } from "@weft/ui/components";
import { createClient } from "@/lib/api/client";
import { startPoller } from "@/lib/api/hooks";

interface Row { orderId: string; vendor: "checkr" | "hireright"; mode: "simulated" | "real"; status: string; consentNeeded: boolean; vendorLabel: string; packageName: string }
const STATUS: Record<string, string> = {
  invited: "Waiting for your authorization", consented: "Authorized", in_progress: "In progress", suspended: "The screening company needs more information",
  disputed: "Under dispute review", complete_clear: "Complete", complete_review: "Complete, with the hiring team", canceled: "Canceled", expired: "Invitation expired",
};
const field = "h-8 w-full rounded-lg border border-[var(--app-border)] bg-card px-2.5 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";

export function ScreeningPortalSection({ principal }: { workerId: string; principal: string }) {
  const api = useMemo(() => createClient({ principal: () => principal || null }), [principal]);
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(async () => { try { setRows((await api.get("/v1/portal/screening")) as unknown as Row[]); } catch { setRows([]); } }, [api]);
  useEffect(() => { void load(); const p = startPoller(() => void load(), 5_000, "/api/v1/portal/screening"); return () => p.stop(); }, [load]);
  if (rows.length === 0) return null;
  return (
    <section id="screening-apply" data-testid="portal-screening" className="flex flex-col gap-3">
      <h2 className="text-3 font-semibold">Background check</h2>
      {rows.map((r) => <ScreeningCard key={r.orderId} row={r} api={api} onDone={load} />)}
    </section>
  );
}

function ScreeningCard({ row, api, onDone }: { row: Row; api: ReturnType<typeof createClient>; onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sign = async () => {
    setBusy(true); setErr(null);
    try { await api.post("/v1/portal/screening/consent", { body: { orderId: row.orderId, typedName: name } }); await onDone(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-4" data-testid="portal-screening-order" data-status={row.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-2 font-medium">{row.packageName} with {row.vendorLabel}</span>
        {row.mode === "simulated" ? <Badge tone="gray">{row.vendor === "hireright" ? "Sandbox, API shape not published" : "Sandbox"}</Badge> : null}
        <span data-testid="portal-screening-status" className="text-1 text-gray-11">{STATUS[row.status] ?? row.status}</span>
      </div>
      {row.consentNeeded ? (
        <div className="mt-4 rounded-lg border border-dashed border-[var(--app-border)] p-4" data-testid="screening-apply-page">
          <p className="mb-3 text-1 font-medium text-gray-10 uppercase">Screening company apply page (sandbox)</p>
          {step === 0 ? (
            <div className="flex flex-col gap-3 text-2">
              <p className="font-medium">Disclosure regarding background investigation</p>
              <p className="text-gray-11">Larkspur Robotics may obtain a consumer report about you from {row.vendorLabel} for employment purposes. This page stands alone so the disclosure is not mixed with anything else.</p>
              <Button size="sm" variant="primary" className="self-start" data-testid="screening-apply-next" onClick={() => setStep(1)}>I have read the disclosure</Button>
            </div>
          ) : step === 1 ? (
            <div className="flex flex-col gap-3 text-2">
              <p className="font-medium">A summary of your rights under the Fair Credit Reporting Act</p>
              <p className="text-gray-11">You may ask for a copy of any report, dispute information that is incomplete or inaccurate, and learn about any adverse decision before it is final. Your state may give you more rights; the screening company shows any state notice here in a real flow.</p>
              <Button size="sm" variant="primary" className="self-start" data-testid="screening-apply-next" onClick={() => setStep(2)}>Continue</Button>
            </div>
          ) : (
            <form className="flex flex-col gap-3 text-2" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
              <p className="font-medium">Authorization</p>
              <p className="text-gray-11">Type your full name to authorize the background check.</p>
              <input required data-testid="screening-apply-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full legal name" />
              <Button type="submit" size="sm" variant="primary" className="self-start" disabled={busy || name.trim().length < 2} data-testid="screening-apply-sign">Authorize</Button>
              {err ? <p role="alert" className="text-1 text-red-11">{err}</p> : null}
            </form>
          )}
        </div>
      ) : null}
    </Card>
  );
}
