"use client";
// The new-hire portal (w2-onboarding), outside the admin shell. The persona arrives through the invite link
// (/portal?as=usr_NNNN, a simulated sign-in) and sees only its own checklist: sign the offer and the agreement by
// typing their name, then the W-4, the state certificate, direct deposit, the I-9 and benefits.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CircleCheck, CircleDashed, Lock } from "lucide-react";
import { Button, Card } from "@weft/ui/components";
import { formatCents, W2_ONBOARDING_TID as T, type PortalTaskKind, type W2OnboardingPortalView } from "@weft/contracts";
import { fmtDate } from "../app/format";
import { ApiError, createClient } from "@/lib/api/client";
import { WeftMark } from "@/components/app/weft-mark";

const KEY = "weft.portalAs";
const field = "h-9 w-full rounded-lg border border-[var(--app-border)] bg-card px-3 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
type View = W2OnboardingPortalView;
type Task = View["tasks"][number];

const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
const cents = (s: string) => Math.round(Number((s || "0").replace(/[$,]/g, "")) * 100);

function usePersona(): string | null {
  const [as, setAs] = useState<string | null>(null);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("as");
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(KEY); } catch { /* storage blocked */ }
    const id = fromUrl && /^usr_\d+$/.test(fromUrl) ? fromUrl : saved;
    if (id) { try { window.localStorage.setItem(KEY, id); } catch { /* storage blocked */ } }
    setAs(id ?? "");
  }, []);
  return as;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex flex-col gap-1 text-1 text-gray-11">{label}{children}{hint ? <span className="text-gray-10">{hint}</span> : null}</label>;
}

function Submit({ busy, testId, children }: { busy: boolean; testId: string; children: ReactNode }) {
  return <Button type="submit" variant="primary" size="lg" disabled={busy} data-testid={testId}>{busy ? "Saving..." : children}</Button>;
}

export function PortalView() {
  const as = usePersona();
  const api = useMemo(() => createClient({ principal: () => as || null }), [as]);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PortalTaskKind | null>(null);
  const load = useCallback(async () => {
    if (!as) return;
    try { const v = (await api.get("/v1/portal/me")) as View; setView(v); setError(null); return v; } catch (e) { setError(msg(e)); return null; }
  }, [api, as]);
  useEffect(() => {
    if (!as) return;
    void (async () => {
      const v = await load();
      if (v?.offer && v.offer.status === "sent") { await api.post("/v1/portal/offer/view").catch(() => undefined); await load(); }
      if (v) setOpen(v.tasks.find((t) => t.status === "pending")?.kind ?? null);
    })();
  }, [as, api, load]);

  const done = async () => {
    const v = await load();
    if (v) setOpen(v.tasks.find((t) => t.status === "pending")?.kind ?? null);
  };

  if (as === null) return <Shell><p className="text-2 text-gray-10">Loading...</p></Shell>;
  if (!as) return <Shell><Card className="p-6"><h1 className="text-5 font-semibold">Welcome</h1><p className="mt-2 text-2 text-gray-11">Open the portal link from your offer email to sign in.</p></Card></Shell>;
  if (error && !view) return <Shell><Card className="p-6" data-testid={T.portalError}><p role="alert" className="text-2 text-red-11">{error}</p></Card></Shell>;
  if (!view) return <Shell><p className="text-2 text-gray-10">Loading your checklist...</p></Shell>;

  const closed = view.offer && (view.offer.status === "voided" || view.offer.status === "expired");
  const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
  return (
    <Shell>
      <div data-testid={T.portalPage} className="flex flex-col gap-6">
        <div>
          <p className="text-1 font-medium uppercase tracking-wide text-gray-10">New-hire portal (simulated)</p>
          <h1 className="mt-1 text-7 font-semibold tracking-tight text-balance">Welcome aboard, {view.worker.displayName.replace(/ \(demo\)$/, "")}</h1>
          <p className="mt-2 text-3 text-gray-11">{view.worker.title} · starts {fmtDate(view.worker.startDate, { month: "short", day: "numeric", year: "numeric" })}{view.worker.workState ? ` · ${view.worker.workState}` : ""}. A few things to finish before your first day.</p>
        </div>
        {closed ? <Card className="p-4"><p role="alert" className="text-2 text-amber-11">This offer is {view.offer!.status === "voided" ? "no longer active" : "past its expiry date"}. Reach out to the hiring team with any questions.</p></Card> : null}
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span data-testid={T.portalCounter} data-done={view.done} data-total={view.total} className="text-3 font-semibold">{view.done} of {view.total} done</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-a3"><div className="h-full rounded-full bg-gray-12 transition-[width]" style={{ width: `${pct}%` }} /></div>
          </div>
          {view.done === view.total ? <p data-testid={T.portalDone} className="mt-3 text-2 text-green-11">All set. You are ready for payday; see you on {fmtDate(view.worker.startDate, { weekday: "long", month: "short", day: "numeric" })}.</p> : null}
        </Card>
        <ol className="flex flex-col gap-3">
          {view.tasks.map((t, n) => (
            <li key={t.kind}>
              <Card className="overflow-hidden" data-testid={T.portalTask} data-kind={t.kind} data-status={t.status}>
                <button type="button" disabled={t.status === "blocked"} onClick={() => setOpen(open === t.kind ? null : t.kind)} className="flex w-full items-center gap-3 p-4 text-left disabled:cursor-not-allowed">
                  {t.status === "done" ? <CircleCheck className="size-5 shrink-0 text-green-11" /> : t.status === "blocked" ? <Lock className="size-5 shrink-0 text-gray-9" /> : <CircleDashed className="size-5 shrink-0 text-gray-10" />}
                  <span className="flex-1 text-3 font-medium">{n + 1}. {t.title}</span>
                  <span className="text-1 text-gray-10">{t.status === "done" ? "Done" : t.status === "blocked" ? "After you sign the offer" : "To do"}</span>
                </button>
                {open === t.kind && t.status === "pending" && !closed ? <div className="border-t border-[var(--app-border)] p-4"><TaskPanel task={t} view={view} api={api} onDone={done} /></div> : null}
              </Card>
            </li>
          ))}
        </ol>
        <p className="text-1 text-gray-10">Everything here is simulated: a fictional company, fictional people and no real tax, bank or identity data.</p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-gray-2">
      <header className="border-b border-[var(--app-border)] bg-card"><div className="mx-auto flex h-14 max-w-[760px] items-center gap-2 px-4"><WeftMark className="size-5" /><span className="text-3 font-semibold">Weft</span><span className="text-2 text-gray-10">· Larkspur Robotics (demo)</span></div></header>
      <main className="mx-auto w-full max-w-[760px] px-4 py-8 tablet:py-12">{children}</main>
    </div>
  );
}

/** A field error in sentence case, without the "routing: " path prefix the API puts in front. */
const FIELD_COPY: Record<string, (m: string) => string> = {
  routing: (m) => (/ABA checksum/.test(m) ? "This routing number fails the ABA checksum. Check the 9 digits." : `Routing number: ${m}`),
  account: (m) => `Account number: ${m}`,
};
function fieldText(field: string | null, text: string): string {
  if (!field) return text;
  const bare = text.startsWith(`${field}: `) ? text.slice(field.length + 2) : text;
  const copy = FIELD_COPY[field];
  return copy ? copy(bare) : bare.charAt(0).toUpperCase() + bare.slice(1);
}

type Api = ReturnType<typeof createClient>;
function TaskPanel({ task, view, api, onDone }: { task: Task; view: View; api: Api; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field: string | null } | null>(null);
  const [name, setName] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await onDone(); } catch (e) { const f = e instanceof ApiError ? ((e.body as { field?: string | null }).field ?? null) : null; setErr({ text: fieldText(f, msg(e)), field: f }); } finally { setBusy(false); }
  };
  const nameField = <Field label="Type your full legal name to sign" hint={`As on your offer: ${view.signer.legalName}`}><input required data-testid={T.typedName} className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></Field>;
  const errorLine = err ? <p role="alert" data-testid={err.field === "routing" ? T.ddError : T.portalError} className="text-2 text-red-11">{err.text}</p> : null;

  if (task.kind === "sign_offer" || task.kind === "sign_confidentiality") {
    const doc = view.documents.find((d) => d.kind === (task.kind === "sign_offer" ? "offer_letter" : "confidentiality_agreement"));
    if (!doc) return <p className="text-2 text-gray-10">This document is not available.</p>;
    return (
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void run(() => api.post("/v1/portal/documents/:id/sign", { params: { id: doc.id }, body: { typedName: name, documentSha256: doc.sha256 } })); }}>
        <pre data-testid={T.docBody} className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-2 p-4 font-sans text-2 leading-relaxed text-gray-12">{doc.bodyText}</pre>
        <p className="text-1 text-gray-10">Document fingerprint (sha256) <code className="font-mono">{doc.sha256.slice(0, 16)}</code>. Your signature records this fingerprint, your name and the time.</p>
        {nameField}
        {errorLine}
        <div><Submit busy={busy} testId={T.signButton}>Sign {task.kind === "sign_offer" ? "and accept the offer" : "the agreement"}</Submit></div>
      </form>
    );
  }
  if (task.kind === "federal_w4") return <W4Form busy={busy} nameField={nameField} errorLine={errorLine} onSubmit={(b) => run(() => api.post("/v1/portal/w4", { body: { ...b, typedName: name } }))} />;
  if (task.kind === "state_withholding") {
    return <StateForm view={view} busy={busy} nameField={nameField} errorLine={errorLine} onSubmit={(b) => run(() => api.post("/v1/portal/state-withholding", { body: { ...b, typedName: name } }))} />;
  }
  if (task.kind === "direct_deposit") return <DdForm busy={busy} nameField={nameField} errorLine={errorLine} onSubmit={(b) => run(() => api.post("/v1/portal/direct-deposit", { body: { ...b, typedName: name } }))} />;
  if (task.kind === "i9_sim") {
    return <I9Form busy={busy} nameField={nameField} errorLine={errorLine} onSubmit={(fd) => run(async () => {
      fd.set("typedName", name);
      const res = await fetch("/api/v1/portal/i9", { method: "POST", headers: { "x-weft-principal": view.signer.principalId }, body: fd });
      const j = (await res.json().catch(() => ({}))) as { message?: string; _tag?: string };
      if (!res.ok) throw new ApiError(res.status, { _tag: (j._tag ?? "Refused") as never, message: j.message ?? res.statusText } as never);
    })} />;
  }
  if (task.kind === "benefits_selection") return <BenefitsForm view={view} busy={busy} nameField={nameField} errorLine={errorLine} onSubmit={(b) => run(() => api.post("/v1/portal/benefits", { body: { ...b, typedName: name } }))} />;
  return null;
}

interface FormProps<B> { busy: boolean; nameField: ReactNode; errorLine: ReactNode; onSubmit: (b: B) => Promise<void> }

function W4Form({ busy, nameField, errorLine, onSubmit }: FormProps<Record<string, unknown>>) {
  const [f, setF] = useState({ filingStatus: "single", step2: false, step3: "0", step4a: "0", step4b: "0", step4c: "0" });
  const submit = (e: FormEvent) => { e.preventDefault(); void onSubmit({ filingStatus: f.filingStatus, step2Checkbox: f.step2, step3Cents: cents(f.step3), step4aCents: cents(f.step4a), step4bCents: cents(f.step4b), step4cCents: cents(f.step4c), exempt: false }); };
  return (
    <form className="grid gap-4 tablet:grid-cols-2" onSubmit={submit}>
      <p className="text-2 text-gray-11 tablet:col-span-2">Form W-4 (2020 and later) tells payroll how much federal income tax to withhold. Amounts are in dollars.</p>
      <Field label="Step 1(c) filing status"><select data-testid={T.w4Filing} className={field} value={f.filingStatus} onChange={(e) => setF({ ...f, filingStatus: e.target.value })}><option value="single">Single or married filing separately</option><option value="mfj">Married filing jointly</option><option value="hoh">Head of household</option></select></Field>
      <label className="flex items-center gap-2 self-end pb-2 text-2"><input type="checkbox" data-testid={T.w4Step2} checked={f.step2} onChange={(e) => setF({ ...f, step2: e.target.checked })} />Step 2(c): two jobs, or a working spouse</label>
      <Field label="Step 3 dependents total ($)"><input data-testid={T.w4Step3} inputMode="decimal" className={field} value={f.step3} onChange={(e) => setF({ ...f, step3: e.target.value })} /></Field>
      <Field label="Step 4(a) other income ($ a year)"><input inputMode="decimal" className={field} value={f.step4a} onChange={(e) => setF({ ...f, step4a: e.target.value })} /></Field>
      <Field label="Step 4(b) deductions ($ a year)"><input inputMode="decimal" className={field} value={f.step4b} onChange={(e) => setF({ ...f, step4b: e.target.value })} /></Field>
      <Field label="Step 4(c) extra withholding ($ per paycheck)"><input data-testid={T.w4Step4c} inputMode="decimal" className={field} value={f.step4c} onChange={(e) => setF({ ...f, step4c: e.target.value })} /></Field>
      <div className="tablet:col-span-2">{nameField}</div>
      <div className="tablet:col-span-2">{errorLine}</div>
      <div><Submit busy={busy} testId={T.w4Submit}>Sign and submit W-4</Submit></div>
    </form>
  );
}

function StateForm({ view, busy, nameField, errorLine, onSubmit }: FormProps<Record<string, unknown>> & { view: View }) {
  const [f, setF] = useState({ filingStatus: "single", allowances: "0", extra: "0" });
  const form = view.stateForm;
  const submit = (e: FormEvent) => { e.preventDefault(); void onSubmit({ state: view.worker.workState, filingStatus: f.filingStatus, allowances: Number(f.allowances) || 0, extraCents: cents(f.extra), exempt: false }); };
  return (
    <form className="grid gap-4 tablet:grid-cols-2" onSubmit={submit}>
      <p className="text-2 text-gray-11 tablet:col-span-2">{form ? `${form.form}: ${form.title}.` : "Your work state has no withholding certificate."}</p>
      <Field label="Filing status"><select data-testid={T.stateFiling} className={field} value={f.filingStatus} onChange={(e) => setF({ ...f, filingStatus: e.target.value })}><option value="single">Single</option><option value="married">Married</option><option value="head_of_household">Head of household</option></select></Field>
      <Field label="Allowances"><input data-testid={T.stateAllowances} inputMode="numeric" className={field} value={f.allowances} onChange={(e) => setF({ ...f, allowances: e.target.value })} /></Field>
      <Field label="Extra withholding ($ per paycheck)"><input inputMode="decimal" className={field} value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} /></Field>
      <div className="tablet:col-span-2">{nameField}</div>
      <div className="tablet:col-span-2">{errorLine}</div>
      <div><Submit busy={busy} testId={T.stateSubmit}>Sign and submit {form?.form ?? "form"}</Submit></div>
    </form>
  );
}

function DdForm({ busy, nameField, errorLine, onSubmit }: FormProps<Record<string, unknown>>) {
  const [f, setF] = useState({ bankName: "Sim Federal Credit Union", routing: "", account: "", accountType: "checking" });
  const submit = (e: FormEvent) => { e.preventDefault(); void onSubmit({ bankName: f.bankName, routing: f.routing.trim(), account: f.account.trim(), accountType: f.accountType }); };
  return (
    <form className="grid gap-4 tablet:grid-cols-2" onSubmit={submit}>
      <p className="text-2 text-gray-11 tablet:col-span-2">Your pay goes to this account. Weft keeps only the last 4 digits; the full numbers stay in the encrypted vault. Use test numbers only.</p>
      <Field label="Bank name"><input data-testid={T.ddBank} className={field} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} /></Field>
      <Field label="Account type"><select className={field} value={f.accountType} onChange={(e) => setF({ ...f, accountType: e.target.value })}><option value="checking">Checking</option><option value="savings">Savings</option></select></Field>
      <Field label="Routing number (9 digits)"><input required data-testid={T.ddRouting} inputMode="numeric" autoComplete="off" className={field} value={f.routing} onChange={(e) => setF({ ...f, routing: e.target.value })} /></Field>
      <Field label="Account number"><input required data-testid={T.ddAccount} inputMode="numeric" autoComplete="off" className={field} value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} /></Field>
      <div className="tablet:col-span-2">{nameField}</div>
      <div className="tablet:col-span-2">{errorLine}</div>
      <div><Submit busy={busy} testId={T.ddSubmit}>Verify and save</Submit></div>
    </form>
  );
}

function I9Form({ busy, nameField, errorLine, onSubmit }: FormProps<FormData>) {
  const [f, setF] = useState({ citizenship: "citizen", documentKind: "us_passport", last4: "", expiresOn: "" });
  const [file, setFile] = useState<File | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("citizenship", f.citizenship); fd.set("documentKind", f.documentKind); fd.set("documentNumberLast4", f.last4); if (f.expiresOn) fd.set("expiresOn", f.expiresOn);
    if (file) fd.set("idImage", file, file.name);
    void onSubmit(fd);
  };
  return (
    <form className="grid gap-4 tablet:grid-cols-2" onSubmit={submit}>
      <p className="text-2 text-gray-11 tablet:col-span-2">I-9 section 1 (simulation). Upload a picture of a sample ID; it is stored on this machine and only ever shown masked.</p>
      <Field label="Citizenship"><select data-testid={T.i9Citizenship} className={field} value={f.citizenship} onChange={(e) => setF({ ...f, citizenship: e.target.value })}><option value="citizen">US citizen</option><option value="noncitizen_national">Noncitizen national</option><option value="permanent_resident">Permanent resident</option><option value="authorized_alien">Authorized to work</option></select></Field>
      <Field label="Document"><select data-testid={T.i9DocKind} className={field} value={f.documentKind} onChange={(e) => setF({ ...f, documentKind: e.target.value })}><option value="us_passport">US passport</option><option value="permanent_resident_card">Permanent resident card</option><option value="drivers_license_and_ssn_card">Driver's license and SSN card</option></select></Field>
      <Field label="Last 4 of the document number"><input required data-testid={T.i9Last4} maxLength={4} className={field} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} /></Field>
      <Field label="Expires"><input type="date" className={field} value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></Field>
      <Field label="ID image (PNG, JPEG, WebP or PDF, up to 5 MB)"><input required type="file" data-testid={T.i9File} accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <div className="tablet:col-span-2">{nameField}</div>
      <div className="tablet:col-span-2">{errorLine}</div>
      <div><Submit busy={busy} testId={T.i9Submit}>Sign and submit I-9</Submit></div>
    </form>
  );
}

const TIERS = [["ee", "You"], ["ee_spouse", "You and spouse"], ["ee_children", "You and children"], ["family", "Family"]] as const;
function BenefitsForm({ view, busy, nameField, errorLine, onSubmit }: FormProps<Record<string, unknown>> & { view: View }) {
  const types = [...new Set(view.plans.map((p) => p.type))];
  const [pick, setPick] = useState<Record<string, { planId: string; tier: string; bps: string }>>(() => Object.fromEntries(types.map((t) => [t, { planId: "", tier: "ee", bps: "400" }])));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const elections = types.filter((t) => pick[t]?.planId).map((t) => ({ planId: pick[t]!.planId, tier: t === "401k" ? null : pick[t]!.tier, deferralBps: t === "401k" ? Number(pick[t]!.bps) || 0 : null }));
    void onSubmit({ elections, waived: types.filter((t) => !pick[t]?.planId) });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <p className="text-2 text-gray-11">Choose a plan for each kind of coverage, or leave it as Waive. Your share comes out of each paycheck before tax.</p>
      {types.map((t) => {
        const plans = view.plans.filter((p) => p.type === t);
        const cur = pick[t]!;
        const plan = plans.find((p) => p.id === cur.planId);
        return (
          <div key={t} className="grid gap-3 rounded-lg border border-[var(--app-border)] p-3 tablet:grid-cols-2">
            <Field label={t === "401k" ? "Retirement (401(k))" : `${t[0]!.toUpperCase()}${t.slice(1)}`}>
              <select data-testid={`${T.benefitsPlan}-${t}`} className={field} value={cur.planId} onChange={(e) => setPick({ ...pick, [t]: { ...cur, planId: e.target.value } })}>
                <option value="">Waive</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.carrier})</option>)}
              </select>
            </Field>
            {plan && t !== "401k" ? (
              <Field label="Coverage">
                <select className={field} value={cur.tier} onChange={(e) => setPick({ ...pick, [t]: { ...cur, tier: e.target.value } })}>
                  {TIERS.filter(([k]) => typeof plan.tierPrices[k] === "number").map(([k, label]) => <option key={k} value={k}>{label}: {formatCents(plan.tierPrices[k]!)} per paycheck</option>)}
                </select>
              </Field>
            ) : null}
            {plan && t === "401k" && plan.deferral ? (
              <Field label={`Contribution (${plan.deferral.minBps / 100}% to ${plan.deferral.maxBps / 100}% of pay)`}>
                <select className={field} value={cur.bps} onChange={(e) => setPick({ ...pick, [t]: { ...cur, bps: e.target.value } })}>
                  {Array.from({ length: (plan.deferral.maxBps - plan.deferral.minBps) / 100 + 1 }, (_, n) => plan.deferral!.minBps + n * 100).map((b) => <option key={b} value={b}>{b / 100}%</option>)}
                </select>
              </Field>
            ) : null}
          </div>
        );
      })}
      {nameField}
      {errorLine}
      <div><Submit busy={busy} testId={T.benefitsSubmit}>Sign and submit elections</Submit></div>
    </form>
  );
}
