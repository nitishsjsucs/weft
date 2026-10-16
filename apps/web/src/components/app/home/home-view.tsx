"use client";
import Link from "next/link";
import { Banknote, ChevronRight, Inbox, Landmark, Users } from "lucide-react";
import { Badge, Card, CardHeading } from "@weft/ui/components";
import { PRINCIPALS, useGet, usePrincipal, useSimClock } from "@/lib/api/hooks";
import { AGENCY, fmtDate, period, relative } from "../format";

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

/** Home: exactly 4 widgets (SPEC 11.3). */
export function HomeView() {
  const who = usePrincipal();
  const clock = useSimClock();
  const now = clock.data?.now;
  const first = (PRINCIPALS.find((p) => p.id === who)?.name ?? "there").split(" ")[0];
  const runs = useGet("/v1/payrolls", { query: { limit: 10 } });
  const props = useGet("/v1/proposals", { query: { status: "pending", limit: 100 }, refreshMs: 5_000 });
  const accounts = useGet("/v1/tax/accounts");
  const workers = useGet("/v1/workers", { query: { type: "employee", limit: 100 } });
  const upcoming = (runs.data?.data ?? []).filter((r) => r.status !== "processed").slice(0, 3);
  const approvals = (props.data?.data ?? []).filter((p) => p.kind !== "suggestion");
  // Headcount (gate report item 5): active employees, with onboarding counted apart; together with offboarding they
  // make GET /v1/stats `employees`. Contractors are not headcount.
  const ws = (workers.data?.data ?? []).filter((w) => w.type === "employee");
  const active = ws.filter((w) => w.status === "active");
  const onboarding = ws.filter((w) => w.status === "onboarding").length;
  const in30 = now ? active.filter((w) => new Date(`${w.startDate}T12:00:00Z`).getTime() >= new Date(now).getTime() - 30 * 86_400_000).length : 0;
  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 py-8 tablet:px-8 laptop:pt-16">
      <h1 className="mb-8 text-7 font-semibold tracking-tight">{greeting(now)}, {first}</h1>
      <div className="grid items-start gap-6 tablet:grid-cols-2">
        <Widget testid="home-widget-payrolls" icon={<Banknote />} title="Upcoming payrolls" href="/app/payroll" footer={<><span>Paid by simulated ACH debit</span><Link href="/app/payroll" className="hover:text-foreground">Review</Link></>}>
          {upcoming.length === 0 ? <div className="p-4 text-2 text-gray-10">{runs.error ? "Payroll is not available yet." : "No upcoming payrolls."}</div> : null}
          {upcoming.map((r) => (
            <Link key={r.id} href={`/app/payroll/${r.id}`} className="flex items-center gap-3 border-b border-[var(--app-border)] px-4 py-3 last:border-0 hover:bg-gray-2">
              <div className="min-w-0 flex-1"><div className="text-2 font-medium">{period(r.periodStart, r.periodEnd)}</div><div className="text-1 text-gray-10">US · Semi-monthly · payday {fmtDate(r.payday)}</div></div>
              <span className={`text-2 font-medium whitespace-nowrap ${r.status === "draft" ? "text-amber-11" : "text-blue-11"}`}>{r.status === "draft" ? (now ? `Due ${relative(r.approvalDeadline, now)}` : "Draft") : r.status}</span>
            </Link>
          ))}
        </Widget>
        <Widget testid="home-widget-approvals" icon={<Inbox />} title="Approvals waiting" href="/app/inbox">
          <div className="flex items-baseline gap-2 px-4 pt-4"><span className="text-7 font-semibold tabular">{props.data ? approvals.length : "-"}</span><span className="text-1 text-gray-10">waiting</span></div>
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
