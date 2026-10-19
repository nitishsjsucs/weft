"use client";
// Portal sections (wave 4, docs/wave4.md). Owner: w4-parity-people. Life events: report a marriage, birth, move and
// the rest, see the window it opened (with the rule it follows) and make benefit changes or choose no change before it
// closes. First-month check-in: the five fixed CHECKIN_QUESTIONS on the caller's own open check-in. Request time off:
// the caller's own balances and requests, and a new request routed to their approver. Calls go to
// /v1/portal/* as the portal principal (the new hire persona reaches only /v1/portal/*).
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CalendarHeart, CalendarPlus, MessageSquareHeart } from "lucide-react";
import { Badge, Button, Card, CardHeading } from "@weft/ui/components";
import { CHECKIN_QUESTIONS, LifeEventKind } from "@weft/contracts";
import { fmtDate } from "../app/format";

/** Test ids for the e2e spec (e2e/gp20-people-life-events.spec.ts repeats the literals). */
export const W4_PEOPLE_TID = {
  lifeSection: "portal-life-events", lifeReport: "portal-life-report", lifeKind: "portal-life-kind", lifeDate: "portal-life-date", lifeNote: "portal-life-note",
  lifeSubmit: "portal-life-submit", lifeRow: (id: string) => `portal-life-event-${id}`, windowCard: (id: string) => `portal-window-${id}`,
  electPlan: (type: string) => `portal-elect-plan-${type}`, electTier: (type: string) => `portal-elect-tier-${type}`, electDeferral: "portal-elect-deferral",
  electSubmit: "portal-elect-submit", electNoChange: "portal-elect-no-change",
  checkinSection: "portal-checkin", checkinField: (k: string) => `portal-checkin-${k}`, checkinSubmit: "portal-checkin-submit", status: "portal-w4-status", error: "portal-w4-error",
  timeOffSection: "portal-time-off", timeOffBalance: (id: string) => `portal-time-off-balance-${id}`, timeOffPolicy: "portal-time-off-policy", timeOffStart: "portal-time-off-start",
  timeOffEnd: "portal-time-off-end", timeOffReason: "portal-time-off-reason", timeOffSubmit: "portal-time-off-submit", timeOffRow: (id: string) => `portal-time-off-request-${id}`,
} as const;
const T = W4_PEOPLE_TID;

const field = "h-9 w-full rounded-lg border border-[var(--app-border)] bg-card px-3 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
const area = "min-h-16 w-full rounded-lg border border-[var(--app-border)] bg-card px-3 py-2 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
const KIND_LABEL: Record<string, string> = {
  marriage: "Marriage", divorce: "Divorce or legal separation", birth: "Birth of a child", adoption: "Adoption or placement for adoption",
  move: "Move to a new home address", loss_of_coverage: "Loss of other coverage", death_of_dependent: "Death of a dependent",
};
const STATUS: Record<string, { label: string; tone: "green" | "gray" | "amber" | "blue" | "red" }> = {
  window_open: { label: "Window open", tone: "blue" }, elected: { label: "Changes made", tone: "green" }, closed_no_change: { label: "No change", tone: "gray" },
  expired: { label: "Window closed", tone: "amber" }, rejected: { label: "Reported too late", tone: "red" }, reported: { label: "Reported", tone: "gray" },
};
const TIERS = [["ee", "Just me"], ["ee_spouse", "Me and a spouse"], ["ee_children", "Me and children"], ["family", "Family"]] as const;

interface Ev { id: string; kind: string; eventDate: string; status: string; windowId: string | null; closesOn: string | null; citation: string; source: string }
interface Win { id: string; status: string; opensOn: string; closesOn: string; lifeEventId: string | null }
interface Plan { id: string; name: string; type: string; carrier: string }
interface Mine { workerId: string | null; lifeEvents: Ev[]; windows: Win[]; plans: Plan[] }
interface Checkin { id: string; dueOn: string; status: string; submittedAt: string | null }
interface Balance { policyId: string; policyName: string; typeName: string; availableMinutes: number | null; available: string | null }
interface TimeOffReq { id: string; policyName: string; status: string; startDate: string; endDate: string; requestedMinutes: number }
interface MyTimeOff { workerId: string | null; balances: Balance[]; requests: TimeOffReq[] }
const REQ_STATUS: Record<string, { label: string; tone: "green" | "gray" | "amber" | "blue" | "red" }> = {
  pending: { label: "Waiting for approval", tone: "amber" }, approved: { label: "Approved", tone: "green" }, denied: { label: "Not approved", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" }, taken: { label: "Taken", tone: "gray" },
};
type Body = { ok?: boolean; summary?: string; message?: string; issues?: { path: string; message: string }[]; extra?: { issues?: { path: string; message: string }[] } } | null;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-1 text-gray-11">{label}{children}</label>;
}

function usePortal(principal: string) {
  const headers = useMemo(() => ({ "x-weft-principal": principal, accept: "application/json", "content-type": "application/json" }), [principal]);
  const get = useCallback(async <R,>(path: string): Promise<R | null> => {
    try { const res = await fetch(`/api${path}`, { headers }); return res.ok ? ((await res.json()) as R) : null; } catch { return null; }
  }, [headers]);
  const post = useCallback(async (path: string, body: unknown): Promise<{ ok: boolean; text: string }> => {
    const res = await fetch(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const b = (await res.json().catch(() => null)) as Body;
    if (!res.ok || !b?.ok) { const i = b?.issues?.[0] ?? b?.extra?.issues?.[0]; return { ok: false, text: i ? `${i.path}: ${i.message}` : b?.message ?? `Not saved (${res.status})` }; }
    return { ok: true, text: b.summary ?? "Saved" };
  }, [headers]);
  // One object per principal: a fresh one each render changed `load` below every render, so its effect refetched in
  // a loop (hundreds of requests a second) until the browser ran out of sockets and navigation away stalled.
  return useMemo(() => ({ get, post }), [get, post]);
}

export function PortalW4People({ principal }: { workerId: string; principal: string }) {
  const api = usePortal(principal);
  const [mine, setMine] = useState<Mine | null>(null);
  const [checks, setChecks] = useState<Checkin[]>([]);
  const [timeOff, setTimeOff] = useState<MyTimeOff | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    setMine(await api.get<Mine>("/v1/portal/life-events"));
    setChecks((await api.get<Checkin[]>("/v1/portal/checkins")) ?? []);
    setTimeOff(await api.get<MyTimeOff>("/v1/portal/time-off"));
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const after = async (r: { ok: boolean; text: string }) => { setNote(r); if (r.ok) await load(); return r.ok; };

  if (!mine?.workerId) return null;
  const open = mine.windows.filter((w) => w.status === "open");
  const checkin = checks.find((c) => c.status === "sent" || c.status === "nudged") ?? null;
  return (
    <>
      {note ? <div role={note.ok ? "status" : "alert"} data-testid={note.ok ? T.status : T.error} className={`rounded-lg px-3 py-2 text-1 ${note.ok ? "bg-gray-3 text-gray-12" : "bg-red-3 text-red-11"}`}>{note.text}</div> : null}
      {checkin ? <CheckinForm checkin={checkin} onSubmit={(a) => api.post(`/v1/portal/checkins/${checkin.id}/submit`, a).then(after)} /> : null}
      <section data-testid={T.lifeSection} className="flex flex-col gap-3">
        <CardHeading icon={<CalendarHeart />}>Life events and benefits</CardHeading>
        {open.map((w) => <ElectionForm key={w.id} win={w} ev={mine.lifeEvents.find((e) => e.id === w.lifeEventId) ?? null} plans={mine.plans}
          onSubmit={(b) => api.post(`/v1/portal/enrollment-windows/${w.id}/elections`, b).then(after)} />)}
        <Card className="p-4">
          {mine.lifeEvents.length ? (
            <ul className="mb-4 flex flex-col gap-2">
              {mine.lifeEvents.map((e) => (
                <li key={e.id} data-testid={T.lifeRow(e.id)} data-status={e.status} className="flex flex-wrap items-center gap-2 text-2">
                  <span className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="text-gray-10">{fmtDate(e.eventDate, { month: "short", day: "numeric", year: "numeric" })}</span>
                  <Badge tone={STATUS[e.status]?.tone ?? "gray"}>{STATUS[e.status]?.label ?? e.status}</Badge>
                  {e.closesOn && e.status === "window_open" ? <span className="text-1 text-gray-10">changes until {fmtDate(e.closesOn, { month: "short", day: "numeric" })} ({e.citation})</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="mb-3 text-2 text-gray-11">A marriage, a new child, a move or losing other coverage lets you change your benefits for a short window after the event.</p>}
          <ReportForm onSubmit={(b) => api.post("/v1/portal/life-events", b).then(after)} />
        </Card>
      </section>
      {timeOff?.workerId ? <TimeOffSection mine={timeOff} onSubmit={(b) => api.post("/v1/portal/time-off/requests", b).then(after)} /> : null}
    </>
  );
}

function TimeOffSection({ mine, onSubmit }: { mine: MyTimeOff; onSubmit: (b: { policyId: string; startDate: string; endDate: string; reason: string }) => Promise<boolean> }) {
  const blank = { policyId: mine.balances[0]?.policyId ?? "", startDate: "", endDate: "", reason: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); if (await onSubmit({ ...f, endDate: f.endDate || f.startDate })) setF(blank); setBusy(false); };
  const recent = [...mine.requests].sort((a, b) => (a.startDate < b.startDate ? 1 : -1)).slice(0, 6);
  return (
    <section data-testid={T.timeOffSection} className="flex flex-col gap-3">
      <CardHeading icon={<CalendarPlus />}>Request time off</CardHeading>
      <Card className="p-4">
        {mine.balances.length ? (
          <ul className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
            {mine.balances.map((b) => <li key={b.policyId} data-testid={T.timeOffBalance(b.policyId)} className="text-2"><span className="text-gray-11">{b.policyName}</span> {b.available !== null ? <><span className="font-medium tabular-nums">{b.available}</span> <span className="text-1 text-gray-10">available</span></> : <span className="text-1 text-gray-10">starts with your first request</span>}</li>)}
          </ul>
        ) : <p className="mb-3 text-2 text-gray-11">You have no time-off policies yet. The people team sets them up.</p>}
        {mine.balances.length ? (
          <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-3">
            <Field label="Type"><select data-testid={T.timeOffPolicy} className={field} value={f.policyId} onChange={(e) => setF({ ...f, policyId: e.target.value })}>{mine.balances.map((b) => <option key={b.policyId} value={b.policyId}>{b.policyName}</option>)}</select></Field>
            <Field label="First day off"><input data-testid={T.timeOffStart} type="date" required className={field} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="Last day off"><input data-testid={T.timeOffEnd} type="date" className={field} value={f.endDate} min={f.startDate || undefined} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            <div className="sm:col-span-3"><Field label="Note for your approver (optional)"><textarea data-testid={T.timeOffReason} maxLength={400} className={area} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
            <p className="text-1 text-gray-10 sm:col-span-3">Weekends and company holidays do not count against your balance.</p>
            <div><Button type="submit" variant="primary" disabled={busy} data-testid={T.timeOffSubmit}>{busy ? "Sending..." : "Request time off"}</Button></div>
          </form>
        ) : null}
        {recent.length ? (
          <ul className="mt-4 flex flex-col gap-2 border-t border-[var(--app-border)] pt-3">
            {recent.map((r) => (
              <li key={r.id} data-testid={T.timeOffRow(r.id)} data-status={r.status} className="flex flex-wrap items-center gap-2 text-2">
                <span className="font-medium">{r.policyName}</span>
                <span className="text-gray-10">{fmtDate(r.startDate, { month: "short", day: "numeric" })}{r.endDate !== r.startDate ? ` to ${fmtDate(r.endDate, { month: "short", day: "numeric" })}` : ""}</span>
                <Badge tone={REQ_STATUS[r.status]?.tone ?? "gray"}>{REQ_STATUS[r.status]?.label ?? r.status}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </section>
  );
}

function ReportForm({ onSubmit }: { onSubmit: (b: { kind: string; eventDate: string; note: string }) => Promise<boolean> }) {
  const [f, setF] = useState({ kind: "marriage", eventDate: "", note: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); if (await onSubmit(f)) setF({ kind: "marriage", eventDate: "", note: "" }); setBusy(false); };
  return (
    <form data-testid={T.lifeReport} onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-2">
      <Field label="What happened"><select data-testid={T.lifeKind} className={field} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{LifeEventKind.options.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
      <Field label="Date of the event"><input data-testid={T.lifeDate} type="date" required className={field} value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} /></Field>
      <div className="sm:col-span-2"><Field label="Anything the people team should know (optional)"><textarea data-testid={T.lifeNote} maxLength={400} className={area} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
      <div><Button type="submit" variant="primary" disabled={busy} data-testid={T.lifeSubmit}>{busy ? "Saving..." : "Report life event"}</Button></div>
    </form>
  );
}

function ElectionForm({ win, ev, plans, onSubmit }: { win: Win; ev: Ev | null; plans: Plan[]; onSubmit: (b: unknown) => Promise<boolean> }) {
  const types = [...new Set(plans.map((p) => p.type))];
  const [pick, setPick] = useState<Record<string, { planId: string; tier: string }>>({});
  const [deferral, setDeferral] = useState("");
  const [busy, setBusy] = useState(false);
  const elections = () => types.flatMap((t): { planId: string; tier: string | null; deferralBps: number | null }[] => {
    const p = pick[t];
    if (!p?.planId) return [];
    if (t === "401k") return [{ planId: p.planId, tier: null, deferralBps: Math.round(Number(deferral || "0") * 100) }];
    return [{ planId: p.planId, tier: p.tier || null, deferralBps: null }];
  });
  const go = async (body: unknown) => { setBusy(true); await onSubmit(body); setBusy(false); };
  return (
    <Card className="p-4" data-testid={T.windowCard(win.id)}>
      <p className="text-3 font-medium">Change your benefits by {fmtDate(win.closesOn, { month: "long", day: "numeric", year: "numeric" })}</p>
      <p className="mt-1 text-1 text-gray-10">{ev ? `${KIND_LABEL[ev.kind] ?? ev.kind} on ${fmtDate(ev.eventDate, { month: "short", day: "numeric" })}. ` : ""}Pick only what you want to change; your carrier gets the update once the people team files it.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {types.map((t) => (
          <div key={t} className="flex flex-col gap-2">
            <Field label={t === "401k" ? "401(k)" : t[0]!.toUpperCase() + t.slice(1)}>
              <select data-testid={T.electPlan(t)} className={field} value={pick[t]?.planId ?? ""} onChange={(e) => setPick({ ...pick, [t]: { planId: e.target.value, tier: pick[t]?.tier ?? "" } })}>
                <option value="">No change</option>{plans.filter((p) => p.type === t).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {t === "401k" ? (pick[t]?.planId ? <Field label="Deferral (% of pay)"><input data-testid={T.electDeferral} inputMode="decimal" className={field} value={deferral} onChange={(e) => setDeferral(e.target.value)} /></Field> : null)
              : pick[t]?.planId ? <Field label="Who is covered"><select data-testid={T.electTier(t)} className={field} value={pick[t]?.tier ?? ""} onChange={(e) => setPick({ ...pick, [t]: { planId: pick[t]!.planId, tier: e.target.value } })}><option value="">Choose</option>{TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field> : null}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} data-testid={T.electSubmit} onClick={() => void go({ elections: elections(), noChange: false })}>Submit changes</Button>
        <Button disabled={busy} data-testid={T.electNoChange} onClick={() => void go({ elections: [], noChange: true })}>I want no change</Button>
      </div>
    </Card>
  );
}

function CheckinForm({ checkin, onSubmit }: { checkin: Checkin; onSubmit: (a: Record<string, unknown>) => Promise<boolean> }) {
  const [a, setA] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    await onSubmit({ settled: Number(a.settled ?? 0), tools: a.tools === "yes", clarity: a.clarity === "yes", blocker: a.blocker ?? "", manager_note: a.manager_note ?? "" });
    setBusy(false);
  };
  return (
    <section data-testid={T.checkinSection} data-checkin={checkin.id}>
      <CardHeading icon={<MessageSquareHeart />}>Your first-month check-in</CardHeading>
      <Card className="p-4">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          {CHECKIN_QUESTIONS.map((q) => (
            <fieldset key={q.key} className="flex flex-col gap-2">
              <legend className="text-2 font-medium">{q.label}</legend>
              {q.kind === "scale" ? (
                <div className="flex gap-2">{[1, 2, 3, 4, 5].map((n) => <label key={n} className="flex items-center gap-1 text-2"><input type="radio" required name={q.key} value={n} data-testid={T.checkinField(`${q.key}-${n}`)} checked={a[q.key] === String(n)} onChange={() => setA({ ...a, [q.key]: String(n) })} />{n}</label>)}</div>
              ) : q.kind === "yes_no" ? (
                <div className="flex gap-4">{["yes", "no"].map((v) => <label key={v} className="flex items-center gap-1 text-2"><input type="radio" required name={q.key} value={v} data-testid={T.checkinField(`${q.key}-${v}`)} checked={a[q.key] === v} onChange={() => setA({ ...a, [q.key]: v })} />{v === "yes" ? "Yes" : "No"}</label>)}</div>
              ) : (
                <textarea data-testid={T.checkinField(q.key)} maxLength={600} className={area} value={a[q.key] ?? ""} onChange={(e) => setA({ ...a, [q.key]: e.target.value })} />
              )}
            </fieldset>
          ))}
          <p className="text-1 text-gray-10">Your manager gets a short summary; they read your written answers in Weft.</p>
          <div><Button type="submit" variant="primary" disabled={busy} data-testid={T.checkinSubmit}>{busy ? "Sending..." : "Send check-in"}</Button></div>
        </form>
      </Card>
    </section>
  );
}
