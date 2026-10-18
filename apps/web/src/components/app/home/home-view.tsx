"use client";
import Link from "next/link";
import { Banknote, CalendarDays, ChevronRight, Inbox, Landmark, Users } from "lucide-react";
import { Badge, Card, CardHeading } from "@weft/ui/components";
import { PRINCIPALS, useGet, usePrincipal, useSimClock } from "@/lib/api/hooks";
import { AGENCY, fmtDate, period, relative, runKind } from "../format";

function greeting(iso: string | undefined): string {
  if (!iso) return "Hello";
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Widget({ icon, title, href, children, footer, testid }: { icon: React.ReactNode; title: string; href: string; children: React.ReactNode; footer?: React.ReactNode; testid: string }) {
  return (
    <section data-testid={testid} className="flex min-w-0 flex-col">
      <CardHeading icon={icon} trailing={<Link href={href} aria-label={`Open ${title}`} className="text-gray-9 hover:text-foreground"><ChevronRight className="size-4" /></Link>}>{title}</CardHeading>
      <Card className="overflow-hidden">{children}</Card>
      {footer ? <div className="mt-2 flex items-center justify-between px-1 text-1 text-gray-10">{footer}</div> : null}
    </section>
  );
}

/** Home: the four SPEC 11.3 widgets plus Time Off (wave 3, w3-timeoff). */
export function HomeView() {
  const who = usePrincipal();
  const clock = useSimClock();
  const now = clock.data?.now;
  const first = (PRINCIPALS.find((p) => p.id === who)?.name ?? "there").split(" ")[0];
  const runs = useGet("/v1/payrolls", { query: { limit: 100 } });   // ordered by id: a year of history fills a short page
  const props = useGet("/v1/proposals", { query: { status: "pending", limit: 100 }, refreshMs: 5_000 });
  const accounts = useGet("/v1/tax/accounts");
  const workers = useGet("/v1/workers", { query: { type: "employee", limit: 100 } });
  const upcoming = (runs.data?.data ?? []).filter((r) => r.status !== "processed").slice(0, 3);
  // Only requests that end today or later: a company with a year of history has more than one page of past ones.
  const todayPt = now ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now)) : undefined;
  const timeOff = useGet("/v1/time-off/requests", { query: { limit: 100, ...(todayPt ? { from: todayPt } : {}) }, refreshMs: 10_000 });
  const approvals = (props.data?.data ?? []).filter((p) => p.kind !== "suggestion");
  // Headcount (gate report item 5): active employees, with onboarding counted apart; together with offboarding they
  // make GET /v1/stats `employees`. Contractors are not headcount.
  const ws = (workers.data?.data ?? []).filter((w) => w.type === "employee");
  const active = ws.filter((w) => w.status === "active");
  const onboarding = ws.filter((w) => w.status === "onboarding").length;
  const in30 = now ? active.filter((w) => new Date(`${w.startDate}T12:00:00Z`).getTime() >= new Date(now).getTime() - 30 * 86_400_000).length : 0;
  // Time Off: out today, pending decisions and approved time off starting in the next 30 days.
  const today = now ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now)) : null;
  const in30Days = today ? new Date(Date.parse(`${today}T12:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10) : null;
  const tor = ((timeOff.data as { data?: { id: string; workerName: string; status: string; startAt: string; endAt: string; approverPrincipalId: string | null; days: { date: string; minutes: number }[] }[] } | undefined)?.data ?? []);
  const outToday = today ? tor.filter((r) => r.status === "approved" && r.days.some((d) => d.date === today && d.minutes > 0)) : [];
  const pendingTor = tor.filter((r) => r.status === "pending");
  // Time-off requests routed to the viewer are decisions too; they live on the Time off page, not in the Inbox.
  const myTor = pendingTor.filter((r) => r.approverPrincipalId === who);
  const soon = today && in30Days ? tor.filter((r) => r.status === "approved" && r.startAt > today && r.startAt <= in30Days).sort((a, b) => (a.startAt < b.startAt ? -1 : 1)) : [];
  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 py-8 tablet:px-8 laptop:pt-16">
      <h1 className="mb-8 text-7 font-semibold tracking-tight">{greeting(now)}, {first}</h1>
      <div className="grid items-start gap-6 tablet:grid-cols-2">
        <Widget testid="home-widget-payrolls" icon={<Banknote />} title="Upcoming payrolls" href="/app/payroll" footer={<><span>Paid by simulated ACH debit</span><Link href="/app/payroll" className="hover:text-foreground">Review</Link></>}>
          {upcoming.length === 0 ? <div className="p-4 text-2 text-gray-10">{runs.error ? "Payroll is not available yet." : "No upcoming payrolls."}</div> : null}
          {upcoming.map((r) => (
            <Link key={r.id} href={`/app/payroll/${r.id}`} className="flex items-center gap-3 border-b border-[var(--app-border)] px-4 py-3 last:border-0 hover:bg-gray-2">
              <div className="min-w-0 flex-1"><div className="text-2 font-medium">{period(r.periodStart, r.periodEnd)}</div><div className="text-1 text-gray-10">US · {runKind(r.subtype).label} · payday {fmtDate(r.payday)}</div></div>
              <span className={`text-2 font-medium whitespace-nowrap ${r.status === "draft" ? "text-amber-11" : "text-blue-11"}`}>{r.status === "draft" ? (now ? `Due ${relative(r.approvalDeadline, now)}` : "Draft") : r.status}</span>
            </Link>
          ))}
        </Widget>
        <Widget testid="home-widget-approvals" icon={<Inbox />} title="Approvals waiting" href="/app/inbox">
          <div className="flex items-baseline gap-2 px-4 pt-4"><span className="text-7 font-semibold tabular">{props.data ? approvals.length : "-"}</span><span className="text-1 text-gray-10">waiting</span>{myTor.length ? <Link data-testid="home-approvals-time-off" href="/app/time-off" className="ml-auto text-1 text-blue-11 hover:underline">+ {myTor.length} time-off {myTor.length === 1 ? "decision" : "decisions"} for you</Link> : null}</div>
          <ul className="px-2 pt-2 pb-2">
            {approvals.slice(0, 3).map((p) => <li key={p.id}><Link href="/app/inbox" className="block truncate rounded-md px-2 py-1.5 text-[13px] hover:bg-gray-2">{p.risk ? <Badge size="xs" className="mr-1.5">{p.risk}</Badge> : null}{p.headline}</Link></li>)}
          </ul>
        </Widget>
        <Widget testid="home-widget-registrations" icon={<Landmark />} title="State tax registrations" href="/app/compliance">
          {accounts.error ? <div className="p-4 text-2 text-gray-10">Registrations are not available yet.</div> : null}
          <ul>
            {(accounts.data ?? []).filter((a) => a.jurisdiction !== "US").map((a) => (
              <li key={a.id} className="flex items-center gap-3 border-b border-[var(--app-border)] px-4 py-2 text-[13px] last:border-0">
                <span className="w-8 font-medium">{a.jurisdiction}</span><span className="min-w-0 flex-1 truncate text-gray-11">{AGENCY[a.agency] ?? a.agency} <span className="text-gray-10">{a.accountType}{a.registeredAt ? ` · since ${fmtDate(a.registeredAt, { month: "short", year: "numeric" })}` : ""}</span></span>
                <Badge tone={a.status === "active" ? "green" : a.status === "awaiting_state" ? "amber" : "gray"}>{humanStatus(a.status)}</Badge>
              </li>
            ))}
          </ul>
        </Widget>
        <Widget testid="home-widget-time-off" icon={<CalendarDays />} title="Time off" href="/app/time-off" footer={<><span>{timeOff.data ? `${soon.length} approved in the next 30 days` : ""}</span><Link href="/app/time-off" className="hover:text-foreground">Review</Link></>}>
          <div className="grid grid-cols-2 gap-2 px-4 pt-4 pb-3">
            <div><div data-testid="home-time-off-out" className="text-7 font-semibold tabular">{timeOff.data ? outToday.length : "-"}</div><div className="text-1 text-gray-10">out today</div></div>
            <div><div data-testid="home-time-off-pending" className="text-7 font-semibold tabular">{timeOff.data ? pendingTor.length : "-"}</div><div className="text-1 text-gray-10">waiting for a decision</div></div>
          </div>
          <ul className="px-2 pb-2">
            {soon.slice(0, 3).map((r) => <li key={r.id}><Link href="/app/time-off" className="flex items-baseline gap-2 truncate rounded-md px-2 py-1.5 text-[13px] hover:bg-gray-2"><span className="min-w-0 flex-1 truncate">{r.workerName}</span><span className="text-1 text-gray-10 tabular">{fmtDate(r.startAt)}{r.endAt !== r.startAt ? ` to ${fmtDate(r.endAt)}` : ""}</span></Link></li>)}
          </ul>
        </Widget>
        <Widget testid="home-widget-headcount" icon={<Users />} title="Headcount" href="/app/people">
          <div className="flex items-baseline gap-2 px-4 pt-4"><span data-testid="home-headcount-active" className="text-7 font-semibold tabular">{workers.data ? active.length : "-"}</span>{in30 ? <span className="text-2 font-medium text-green-11">+{in30}</span> : null}<span className="text-1 text-gray-10">30d</span></div>
          <div className="flex flex-wrap items-baseline gap-x-3 px-4 pt-1 pb-4 text-1 text-gray-10">
            <span>Active employees</span>
            {workers.data ? <span data-testid="home-headcount-onboarding"><span className="font-medium text-gray-11 tabular">{onboarding}</span> onboarding</span> : null}
          </div>
        </Widget>
      </div>
    </div>
  );
}

/** "awaiting_state" to "Awaiting state". */
function humanStatus(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
