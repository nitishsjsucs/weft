// Product grid for the landing page: six cards, each with an original mini UI drawn from the seed's facts.
// Owner: t6-site.
import type { ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronRight, Circle } from "lucide-react";

function Well({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[218px] overflow-hidden rounded-lg bg-gray-2 p-4">
      <div className="h-full [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]">{children}</div>
    </div>
  );
}

const Panel = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-lg bg-white p-3 text-1 shadow-[var(--shadow-card)] ${className}`}>{children}</div>
);

function PeopleUI() {
  const tasks: [string, boolean][] = [["W-4 and CO withholding profile", true], ["Direct deposit, Tidepool Federal Credit Union", true], ["Google Workspace, GitHub, chat", true], ["Colorado registrations", false], ["Laptop ordered", false]];
  return (
    <Panel>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-[var(--violet-9)] text-0 font-medium text-white">NC</span>
        <span className="font-medium text-gray-12">Noor Castellanos</span>
        <span className="ml-auto text-gray-10">Starts Nov 2</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {tasks.map(([t, done]) => (
          <li key={t} className="flex items-center gap-2 text-gray-11">
            {done ? <Check className="size-3.5 text-green-11" strokeWidth={2} /> : <Circle className="size-3.5 text-gray-8" strokeWidth={1.5} />}
            <span className={done ? "" : "text-gray-12"}>{t}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PayrollUI() {
  const rows = [["NY raise, +18%", "Gross change"], ["TX tech, 120.00 h", "Hours spike"], ["CA hire, Oct 19", "No bank account"], ["NY, ends Oct 23", "Prorated"]];
  return (
    <Panel className="p-0">
      <div className="flex items-center gap-2 bg-amber-9/20 px-3 py-1.5 font-medium text-gray-12"><span className="size-2 rounded-full bg-amber-9" />Needs Review (4)</div>
      {rows.map(([who, flag]) => (
        <div key={who} className="flex items-center justify-between border-t border-border px-3 py-1.5">
          <span className="text-gray-12">{who}</span><span className="rounded-full bg-gray-3 px-1.5 text-0 text-gray-11">{flag}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 border-t border-border bg-green-9/20 px-3 py-1.5 font-medium text-gray-12"><span className="size-2 rounded-full bg-green-9" />Ready for Approval (44)</div>
    </Panel>
  );
}

function BenefitsUI() {
  return (
    <Panel>
      <div className="flex items-center justify-between"><span className="font-medium text-gray-12">Juniper PPO 1500</span></div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {[["Employee only", "$95.00"], ["Family", "$310.00"], ["Employer", "$380.00"], ["Enrolled", "30 of 48"]].map(([k, v]) => (
          <div key={k} className="rounded-md bg-gray-2 px-2 py-1.5"><div className="text-0 text-gray-10">{k}</div><div className="font-medium text-gray-12 tabular-nums">{v}</div></div>
        ))}
      </div>
    </Panel>
  );
}

function TaxUI() {
  const states: [string, string, string][] = [["CA", "UI 3.4%", "Active"], ["NY", "UI 4.1%", "Active"], ["TX", "UI 2.7%", "Active"], ["CO", "Pending", "Awaiting state"]];
  return (
    <Panel className="p-0">
      {states.map(([s, r, st], i) => (
        <div key={s} className={`flex items-center gap-3 px-3 py-2 ${i ? "border-t border-border" : ""}`}>
          <span className="w-6 font-medium text-gray-12">{s}</span><span className="flex-1 text-gray-11 tabular-nums">{r}</span>
          <span className={`rounded-full px-1.5 text-0 ${st === "Active" ? "bg-green-3 text-green-11" : "bg-amber-3 text-amber-11"}`}>{st}</span>
        </div>
      ))}
    </Panel>
  );
}

function ItUI() {
  return (
    <Panel>
      <div className="mb-2 font-medium text-gray-12">Accounts for a new hire</div>
      {[["Google Workspace", "Active"], ["GitHub", "Active"], ["Team chat", "Active"], ["Laptop, $1,899.00", "Needs approval"]].map(([k, v]) => (
        <div key={k} className="flex items-center justify-between py-1 text-gray-11"><span>{k}</span><span className={v === "Active" ? "text-green-11" : "text-amber-11"}>{v}</span></div>
      ))}
    </Panel>
  );
}

function ContractorsUI() {
  return (
    <Panel className="p-0">
      {[["Lisbon", "EUR 6,500"], ["Pune", "INR 410,000"], ["Toronto", "CAD 9,800"]].map(([c, a], i) => (
        <div key={c} className={`flex items-center justify-between px-3 py-2 ${i ? "border-t border-border" : ""}`}><span className="text-gray-12">{c}</span><span className="text-gray-11 tabular-nums">{a} a month</span></div>
      ))}
      <div className="border-t border-border px-3 py-2 text-0 text-gray-10">Fixed FX table, not market data</div>
    </Panel>
  );
}

const CARDS: { href: string; title: string; body: string; ui: () => ReactNode }[] = [
  { href: "/app/people", title: "People and onboarding", body: "Accept an offer and the new hire gets a checklist, accounts and a welcome post, with the paperwork that needs a person waiting in the Inbox.", ui: PeopleUI },
  { href: "/app/payroll", title: "Payroll", body: "Gross to net for federal, CA, NY, TX and CO, tested to the cent. Anomalies are flagged and explained before anyone submits.", ui: PayrollUI },
  { href: "/app/compliance", title: "Taxes and compliance", body: "Agency notices are read, matched to the right account and turned into rate changes and filed replies that you approve.", ui: TaxUI },
  { href: "/app/benefits", title: "Benefits", body: "Medical, dental, vision, HSA and 401(k) plans with real enrollments; carrier reconciliation comes next.", ui: BenefitsUI },
  { href: "/app/it", title: "IT provisioning", body: "Workspace, code and chat accounts on day one, and a laptop order that waits for an approval because it costs money.", ui: ItUI },
  { href: "/app/contractors", title: "Global contractors", body: "Contractors in three countries and currencies are seeded today; payouts against a fixed FX table come next.", ui: ContractorsUI },
];

export function ProductGrid() {
  return (
    <ul className="grid gap-x-12 gap-y-14 tablet:grid-cols-2 laptop:grid-cols-3">
      {CARDS.map((c) => (
        <li key={c.title}>
          <Link href={c.href} className="group flex flex-col gap-5">
            <Well>{c.ui()}</Well>
            <div className="flex flex-col gap-2">
              <h3 className="text-3 font-medium text-gray-12">{c.title}</h3>
              <p className="text-3 text-gray-11">{c.body}</p>
              <span className="inline-flex items-center gap-0.5 text-2 text-gray-11">Explore <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} /></span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
