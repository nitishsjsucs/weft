"use client";
// Time Off (wave 3, w3-timeoff): Requests, Calendar, Balances, Policies and Holidays. Every amount is minutes from the
// append-only ledger, shown as hours. Requests carry their deterministic checks and routing; the routed approver (or
// the People admin) decides here, and the server checks that a manager decides only for direct reports.
import { useMemo, useState } from "react";
import { CalendarDays, CalendarRange, Check, ClipboardList, Landmark, Scale, X } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import { W3_TIMEOFF_TID as TID, type ToolOutcome } from "@weft/contracts";
import { client, errorText, PRINCIPALS, useGet, useMutation, usePrincipal } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { fmtDate } from "../format";

export interface TimeOffRequestRow {
  id: string; workerId: string; workerName: string; departmentId: string | null; policyId: string; policyName: string; typeKind: string | null;
  status: string; startAt: string; endAt: string; requestedMinutes: number; days: { date: string; minutes: number; holiday: boolean }[];
  reason: string; approverPrincipalId: string | null; routing: { principalId: string | null; why: string }[];
  checks: { rule: string; severity: "info" | "review" | "block"; message: string; evidence: { label: string; ref: string }[] }[];
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
}
export interface TimeOffBalanceRow {
  workerId: string; policyId: string; policyName: string; typeName: string; typeKind: string;
  accruedUnlockedMinutes: number; accruedLockedMinutes: number; usedMinutes: number; holdsMinutes: number; availableMinutes: number;
}
interface PolicyRow {
  id: string; name: string; type: string; type_name: string; paid: boolean; jurisdiction: string; schedule: string; minutes_per_period: number | null;
  tiers: { min_service_months: number; minutes_per_period: number }[]; worked_minutes_per_chunk: number | null; minutes_per_chunk: number | null;
  accrual_cap_minutes: number | null; annual_accrual_cap_minutes: number | null; carryover_cap_minutes: number | null; annual_use_cap_minutes: number | null;
  front_load_minutes: number | null; waiting_days_before_use: number; min_increment_minutes: number; pay_out_at_separation: boolean; sources: { label: string; url: string }[];
}
interface CalendarDay { date: string; out: { workerId: string; requestId: string; status: string }[]; holiday: string | null; outPct: number; overLimit: boolean; headcount: number }
interface Calendar { departmentId: string; departmentName: string; from: string; to: string; headcount: number; maxOutPct: number; minPresent: number; days: CalendarDay[] }

export const hrs = (m: number) => `${(m / 60).toFixed(2)} h`;
const SEVERITY_TONE = { block: "red", review: "amber", info: "gray" } as const;
const STATUS_TONE: Record<string, "amber" | "green" | "red" | "gray" | "blue"> = { pending: "amber", approved: "green", denied: "red", cancelled: "gray", taken: "blue" };
const RULE_LABEL: Record<string, string> = {
  INSUFFICIENT_BALANCE: "Balance too low", WAITING_PERIOD: "Waiting period", USE_CAP: "Over the use cap", INCREMENT: "Below the minimum",
  COVERAGE_CONFLICT: "Coverage", OVERLAPS_PAYROLL_DEADLINE: "Payroll deadline", INCLUDES_HOLIDAY: "Includes holidays", SHORT_NOTICE: "Short notice",
};
const PRINCIPAL_NAMES: Record<string, string> = { ...Object.fromEntries(PRINCIPALS.map((p) => [p.id, p.name])), usr_imani: "Imani Ferreira (demo)" };
export const principalName = (id: string | null) => (id ? PRINCIPAL_NAMES[id] ?? id : "nobody");
const range = (r: Pick<TimeOffRequestRow, "startAt" | "endAt">) => (r.startAt === r.endAt ? fmtDate(r.startAt, { weekday: "short", month: "short", day: "numeric" }) : `${fmtDate(r.startAt)} to ${fmtDate(r.endAt)}`);
const today = (iso: string | undefined) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso)) : "2026-10-26");

function Empty({ text }: { text: string }) { return <p className="px-4 py-4 text-[13px] text-gray-10">{text}</p>; }

export function CheckChips({ checks }: { checks: TimeOffRequestRow["checks"] }) {
  if (!checks.length) return <span className="text-1 text-gray-10">No checks fired</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {checks.map((c) => <Badge key={c.rule} tone={SEVERITY_TONE[c.severity]} data-testid={TID.check(c.rule)} title={c.message}>{RULE_LABEL[c.rule] ?? c.rule}</Badge>)}
    </span>
  );
}

function RequestCard({ r, viewer, onDone }: { r: TimeOffRequestRow; viewer: string; onDone: (text: string) => void }) {
  const [note, setNote] = useState("");
  const decide = useMutation(async (decision: "approve" | "deny") => (await client.post("/v1/time-off/requests/:id/decide", { params: { id: r.id }, body: { decision, note } })) as ToolOutcome);
  const canDecide = r.status === "pending" && (viewer === r.approverPrincipalId || viewer === "usr_dana");
  const blocked = r.checks.some((c) => c.severity === "block");
  const go = async (d: "approve" | "deny") => { const o = await decide.run(d); if (o && o.ok) onDone(o.status === "done" ? o.summary : `Proposal ${o.proposalId} is waiting in the Inbox`); };
  return (
    <li data-testid={TID.requestRow(r.id)} data-status={r.status} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{r.workerName}</span>
        <span className="text-[13px] text-gray-11">{r.policyName}</span>
        <span className="text-[13px] tabular-nums">{range(r)}</span>
        <span className="font-mono text-1 text-gray-11">{hrs(r.requestedMinutes)}</span>
        <Badge tone={STATUS_TONE[r.status] ?? "gray"} className="ml-auto">{r.status}</Badge>
      </div>
      <CheckChips checks={r.checks} />
      {r.checks.filter((c) => c.severity !== "info").map((c) => <p key={c.rule} className="text-1 text-gray-11">{c.message}</p>)}
      <p className="text-1 text-gray-10">
        {r.status === "pending" ? <>Routed to <span className="text-gray-12">{principalName(r.approverPrincipalId)}</span>{r.routing.length > 1 ? `: ${r.routing.filter((s) => !s.principalId).map((s) => s.why).join("; ")}` : ""}</>
          : r.decidedBy ? <>Decided by {principalName(r.decidedBy)}{r.decisionNote ? `: ${r.decisionNote}` : ""}</> : null}
      </p>
      {r.reason ? <p className="text-1 text-gray-10">Employee note (as written): <q className="text-gray-11">{r.reason}</q></p> : null}
      {decide.error ? <p role="alert" className="text-1 text-red-11">{errorText(decide.error)}</p> : null}
      {canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Decision note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} placeholder="Note (optional)"
            className="h-8 min-w-0 flex-1 rounded-md bg-card px-2 text-[13px] shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-accent-8" />
          <Button size="sm" variant="primary" data-testid={TID.decide("approve")} disabled={decide.pending || blocked} title={blocked ? "A block check stands" : undefined} onClick={() => void go("approve")}><Check /> Approve</Button>
          <Button size="sm" data-testid={TID.decide("deny")} disabled={decide.pending} onClick={() => void go("deny")}><X /> Deny</Button>
        </div>
      ) : r.status === "pending" ? <p className="text-1 text-gray-10">Waiting on {principalName(r.approverPrincipalId)}.</p> : null}
    </li>
  );
}

export function RequestsTab({ workerId }: { workerId?: string } = {}) {
  const q = useGet("/v1/time-off/requests", { query: { limit: 100, ...(workerId ? { workerId } : {}) }, refreshMs: 10_000 });
  const clock = useGet("/v1/sim/clock");
  const viewer = usePrincipal();
  const [notice, setNotice] = useState<string | null>(null);
  const rows = ((q.data as { data?: TimeOffRequestRow[] } | undefined)?.data ?? []);
  const day = today(clock.data?.now);
  const pending = rows.filter((r) => r.status === "pending").sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const upcoming = rows.filter((r) => r.status === "approved" && r.endAt >= day).sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const past = rows.filter((r) => !pending.includes(r) && !upcoming.includes(r)).sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
  const section = (title: string, list: TimeOffRequestRow[], empty: string) => (
    <section className="flex flex-col gap-2">
      <h2 className="text-2 font-medium text-gray-11">{title} <span className="text-gray-10">{list.length}</span></h2>
      <Card className="overflow-hidden">{list.length === 0 ? <Empty text={q.data ? empty : "Loading..."} /> : <ul className="divide-y divide-gray-4">{list.map((r) => <RequestCard key={r.id} r={r} viewer={viewer} onDone={setNotice} />)}</ul>}</Card>
    </section>
  );
  return (
    <div className="flex flex-col gap-6">
      {q.error ? <div role="alert" className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(q.error)}</div> : null}
      {notice ? <div role="status" className="rounded-lg bg-gray-3 px-3 py-2 text-1 text-gray-12">{notice}</div> : null}
      {section("Waiting for a decision", pending, "Nothing is waiting.")}
      {section("Upcoming", upcoming, "No approved time off ahead.")}
      {section("Past and closed", past, "No history yet.")}
    </div>
  );
}

function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}
const shiftMonth = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export function CalendarTab() {
  const company = useGet("/v1/company");
  const reqs = useGet("/v1/time-off/requests", { query: { status: "pending", limit: 100 } });
  const workers = useGet("/v1/workers", { query: { limit: 100 } });
  const depts = ((company.data as { departments?: { id: string; name: string }[] } | undefined)?.departments ?? []);
  // Opens on the first pending request with a coverage conflict (else the first pending one): its department and month.
  const pendingRows = ((reqs.data as { data?: TimeOffRequestRow[] } | undefined)?.data ?? []).slice().sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  const firstPending = pendingRows.find((r) => r.checks.some((c) => c.rule === "COVERAGE_CONFLICT")) ?? pendingRows[0];
  const [dept, setDept] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const deptId = dept ?? firstPending?.departmentId ?? depts[0]?.id ?? "dpt_hardware";
  const ym = month ?? (firstPending ? firstPending.startAt.slice(0, 7) : "2026-11");
  const b = monthBounds(ym);
  const cal = useGet("/v1/time-off/calendar", { query: { departmentId: deptId, from: b.from, to: b.to } });
  const data = cal.data as Calendar | undefined;
  const names = new Map((((workers.data as { data?: { id: string; displayName: string; departmentId: string | null; type: string; status: string }[] } | undefined)?.data) ?? []).map((w) => [w.id, w]));
  const people = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, w] of names) if (w.departmentId === deptId && w.type === "employee" && w.status !== "inactive") ids.add(id);
    for (const d of data?.days ?? []) for (const o of d.out) ids.add(o.workerId);
    return [...ids].sort((a, b) => (names.get(a)?.displayName ?? a).localeCompare(names.get(b)?.displayName ?? b));
  }, [names, deptId, data]);
  const weekdays = (data?.days ?? []).filter((d) => { const g = new Date(`${d.date}T12:00:00Z`).getUTCDay(); return g !== 0 && g !== 6; });
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <CardHeading icon={<CalendarRange />}>{data?.departmentName ?? "Team"} calendar</CardHeading>
        <select aria-label="Department" value={deptId} onChange={(e) => setDept(e.target.value)} className="ml-auto h-8 rounded-md bg-card px-2 text-[13px] shadow-[var(--shadow-border)]">
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <Button size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(ym, -1))}>Prev</Button>
        <span className="min-w-[88px] text-center text-[13px] tabular-nums">{fmtDate(`${ym}-01`, { month: "long", year: "numeric" })}</span>
        <Button size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(ym, 1))}>Next</Button>
      </div>
      {cal.error ? <div role="alert" className="rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(cal.error)}</div> : null}
      <Card className="overflow-x-auto">
        <table data-testid={TID.calendar} className="w-full border-separate border-spacing-0 text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-gray-11">Person</th>
              {weekdays.map((d) => <th key={d.date} className={`px-1 py-2 text-center font-normal tabular-nums ${d.holiday ? "bg-gray-3 text-gray-10" : "text-gray-11"}`} title={d.holiday ?? undefined}>{Number(d.date.slice(8))}</th>)}
            </tr>
          </thead>
          <tbody>
            {people.map((id) => (
              <tr key={id}>
                <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-1.5">{names.get(id)?.displayName ?? id}</td>
                {weekdays.map((d) => {
                  const o = d.out.find((x) => x.workerId === id);
                  return <td key={d.date} className={`h-7 px-0.5 text-center ${d.holiday ? "bg-gray-3" : ""}`}>{o ? <span className={`block h-5 rounded ${o.status === "pending" ? "bg-accent-3 outline outline-1 outline-dashed outline-accent-8" : "bg-accent-4"}`} title={`${o.requestId} (${o.status})`} /> : null}</td>;
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky left-0 z-10 bg-card px-3 py-2 text-gray-10">Out</td>
              {weekdays.map((d) => (
                <td key={d.date} data-testid={TID.calendarDay(d.date)} data-over={d.overLimit ? "true" : "false"} className={`px-0.5 py-2 text-center font-mono text-[11px] tabular-nums ${d.holiday ? "bg-gray-3 text-gray-10" : d.overLimit ? "rounded text-red-11 outline outline-1 outline-red-8" : "text-gray-10"}`}>
                  {d.holiday ? "hol" : d.out.length ? `${Math.round(d.outPct)}%` : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </Card>
      <p className="text-1 text-gray-10">
        {data ? `${data.departmentName}: ${data.headcount} people including incoming hires. A day is outlined when more than ${data.maxOutPct}% are out or fewer than ${data.minPresent} remain. Solid marks are approved, dashed are pending; shaded columns are company holidays.` : "Loading..."}
      </p>
    </section>
  );
}

export function BalancesTab({ workerId }: { workerId?: string } = {}) {
  const q = useGet("/v1/time-off/balances", { query: workerId ? { workerId } : {} });
  const workers = useGet("/v1/workers", { query: { limit: 100 } });
  const names = new Map((((workers.data as { data?: { id: string; displayName: string }[] } | undefined)?.data) ?? []).map((w) => [w.id, w.displayName]));
  const rows = ((q.data ?? []) as TimeOffBalanceRow[]).slice().sort((a, b) => (a.workerId === b.workerId ? (a.policyId < b.policyId ? 1 : -1) : a.workerId < b.workerId ? -1 : 1));
  return (
    <section className="flex flex-col gap-2">
      {workerId ? null : <CardHeading icon={<Scale />}>Balances</CardHeading>}
      <Card className="overflow-x-auto">
        {rows.length === 0 ? <Empty text={q.data ? "No balances." : "Loading..."} /> : (
          <Table className="text-[13px]">
            <THead><TR>{workerId ? null : <TH>Person</TH>}<TH>Policy</TH><TH numeric>Available</TH><TH numeric className="hidden tablet:table-cell">Used</TH><TH numeric className="hidden tablet:table-cell">Holds</TH><TH numeric className="hidden tablet:table-cell">Locked</TH></TR></THead>
            <TBody>
              {rows.map((b) => (
                <TR key={`${b.workerId}-${b.policyId}`} data-testid={TID.balance(b.workerId, b.policyId)}>
                  {workerId ? null : <TD className="h-9 whitespace-nowrap">{names.get(b.workerId) ?? b.workerId}</TD>}
                  <TD className="h-9 whitespace-nowrap">{b.policyName}</TD>
                  <TD numeric className="h-9 font-mono text-1">{hrs(b.availableMinutes)}</TD>
                  <TD numeric className="hidden h-9 font-mono text-1 tablet:table-cell">{hrs(b.usedMinutes)}</TD>
                  <TD numeric className="hidden h-9 font-mono text-1 tablet:table-cell">{hrs(b.holdsMinutes)}</TD>
                  <TD numeric className="hidden h-9 font-mono text-1 tablet:table-cell">{b.accruedLockedMinutes ? hrs(b.accruedLockedMinutes) : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <p className="text-1 text-gray-10">Available is accrued minus used minus holds. Holds are pending requests and approved days not yet taken; locked time is accrued inside a waiting period.</p>
    </section>
  );
}

function ruleLines(p: PolicyRow): string[] {
  const out: string[] = [];
  if (p.schedule === "per_pay_period") out.push(p.tiers.length ? `Accrues ${p.tiers.map((t) => `${hrs(t.minutes_per_period)} a pay period from ${t.min_service_months} months`).join(", then ")}` : `Accrues ${hrs(p.minutes_per_period ?? 0)} a pay period`);
  if (p.schedule === "per_hour_worked") out.push(`Accrues ${p.minutes_per_chunk ?? 1} minute for every ${p.worked_minutes_per_chunk ?? 30} minutes worked (exempt staff count 40 hours a week)`);
  if (p.schedule === "front_load_annual") out.push(`${hrs(p.front_load_minutes ?? 0)} at the start of each year and on hire`);
  if (p.accrual_cap_minutes !== null) out.push(`Balance cap ${hrs(p.accrual_cap_minutes)}`);
  if (p.annual_accrual_cap_minutes !== null) out.push(`Accrues at most ${hrs(p.annual_accrual_cap_minutes)} a year`);
  out.push(p.carryover_cap_minutes === null ? "Everything carries into the next year" : p.carryover_cap_minutes === 0 ? "Nothing carries into the next year" : `Carries up to ${hrs(p.carryover_cap_minutes)}`);
  if (p.annual_use_cap_minutes !== null) out.push(`Use up to ${hrs(p.annual_use_cap_minutes)} a year`);
  if (p.waiting_days_before_use) out.push(`Usable after ${p.waiting_days_before_use} days of employment`);
  out.push(`Minimum increment ${hrs(p.min_increment_minutes)}`);
  out.push(p.pay_out_at_separation ? "Paid out in final pay" : "Not paid out at separation");
  return out;
}

export function PoliciesTab() {
  const q = useGet("/v1/time-off/policies");
  const list = (q.data ?? []) as PolicyRow[];
  return (
    <section className="flex flex-col gap-3">
      <CardHeading icon={<ClipboardList />}>Policies</CardHeading>
      {list.length === 0 ? <Card><Empty text={q.data ? "No policies." : "Loading..."} /></Card> : (
        <div className="grid gap-3 tablet:grid-cols-2">
          {list.map((p) => (
            <Card key={p.id} className="flex flex-col gap-2 p-4" data-testid={`time-off-policy-${p.id}`}>
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.name}</span><Badge tone="outline">{p.jurisdiction}</Badge>{p.paid ? null : <Badge>Unpaid</Badge>}</div>
              <ul className="list-disc pl-5 text-[13px] text-gray-11">{ruleLines(p).map((l) => <li key={l}>{l}</li>)}</ul>
              {p.sources.length ? <p className="text-1 text-gray-10">Sources: {p.sources.map((s, i) => <span key={s.url}>{i ? ", " : ""}<a className="underline decoration-gray-7 underline-offset-2 hover:text-gray-12" href={s.url} target="_blank" rel="noreferrer">{s.label}</a></span>)}</p> : null}
            </Card>
          ))}
        </div>
      )}
      <p className="text-1 text-gray-10">These rules come from public agency pages and are research, not legal advice. California and Colorado vacation never forfeits; Weft refuses a policy that would.</p>
    </section>
  );
}

export function HolidaysTab() {
  const q = useGet("/v1/time-off/holidays", { query: { year: 2026 } });
  const list = (q.data ?? []) as { date: string; name: string }[];
  return (
    <section className="flex flex-col gap-2">
      <CardHeading icon={<Landmark />}>Company holidays 2026</CardHeading>
      <Card className="overflow-hidden">
        {list.length === 0 ? <Empty text={q.data ? "No holidays." : "Loading..."} /> : (
          <Table className="text-[13px]">
            <THead><TR><TH>Date</TH><TH>Holiday</TH></TR></THead>
            <TBody>{list.map((h) => <TR key={h.date}><TD className="h-9 whitespace-nowrap tabular-nums">{fmtDate(h.date, { weekday: "short", month: "short", day: "numeric" })}</TD><TD className="h-9">{h.name}</TD></TR>)}</TBody>
          </Table>
        )}
      </Card>
      <p className="text-1 text-gray-10">Holidays count 0 h inside a request and are paid as holiday lines on paychecks. Paydays do not move for holidays.</p>
    </section>
  );
}

export function TimeOffView() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Time Off" subtitle="Balances come from an append-only ledger in minutes. A request takes its hours from the dates and the holiday calendar, runs its checks and goes to the person who decides." />
      <Tabs defaultValue="requests">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="requests" data-testid={TID.tab("requests")}><CalendarDays className="size-3.5" /> Requests</TabsTrigger>
          <TabsTrigger value="calendar" data-testid={TID.tab("calendar")}>Calendar</TabsTrigger>
          <TabsTrigger value="balances" data-testid={TID.tab("balances")}>Balances</TabsTrigger>
          <TabsTrigger value="policies" data-testid={TID.tab("policies")}>Policies</TabsTrigger>
          <TabsTrigger value="holidays" data-testid={TID.tab("holidays")}>Holidays</TabsTrigger>
        </TabsList>
        <TabsContent value="requests"><RequestsTab /></TabsContent>
        <TabsContent value="calendar"><CalendarTab /></TabsContent>
        <TabsContent value="balances"><BalancesTab /></TabsContent>
        <TabsContent value="policies"><PoliciesTab /></TabsContent>
        <TabsContent value="holidays"><HolidaysTab /></TabsContent>
      </Tabs>
    </div>
  );
}
