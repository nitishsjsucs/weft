// Landing page sections (SPEC 11.2; structure after research/design.md 13.1, copy original). Owner: t6-site.
// Every name on this page is either Weft's own or a fictional "(demo)" record from the seed; every agency, bank and
// vendor named here is a simulator in this repo.
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight, Banknote, Building2, ChevronRight, CircleCheck, HeartPulse, KeyRound, Landmark, Laptop, MessageSquare,
  MousePointer2, PiggyBank, ScrollText, ShieldCheck, Undo2, Workflow,
} from "lucide-react";
import { LoomField, WeaveMark, Wordmark, WovenBands } from "./brand";
import { CopyCommand, SimClockTicker } from "./client";
import type { LandingStats } from "./live";
import css from "./marketing.module.css";

const Container = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`mx-auto w-full max-w-[1280px] px-4 laptop:px-8 ${className}`}>{children}</div>
);

// ---- announcement and nav ----------------------------------------------------------------------------------------

export function Announcement() {
  return (
    <div className="bg-ink-surface text-white">
      <Container className="flex h-11 items-center justify-center gap-3 text-2 font-medium">
        <span className="text-[var(--accent-8)]">New</span>
        <span className="h-4 w-px bg-white/20" aria-hidden />
        <a href="#how-it-works" className="flex min-w-0 items-center gap-1 text-white/85 hover:text-white">
          <span className="truncate">Weft 0.1 runs a whole fictional company on your laptop</span>
          <ChevronRight className="size-4 shrink-0" strokeWidth={1.5} />
        </a>
      </Container>
    </div>
  );
}

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agent", label: "Agent" },
  { href: "#simulators", label: "Simulators" },
  { href: "#numbers", label: "Numbers" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-foreground/[0.06] bg-background/95 backdrop-blur-sm">
      <Container className="flex h-14 items-center gap-4">
        <Link href="/" aria-label="Weft home" className="shrink-0"><Wordmark /></Link>
        <nav aria-label="Main" className="hidden flex-1 items-center justify-center gap-1 laptop:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="weft-press rounded-lg px-3 py-1.5 text-2 font-book text-gray-12/80 hover:bg-foreground/[0.06]">{n.label}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 laptop:ml-0">
          <a href="#how-it-works" className="weft-press hidden h-8 items-center rounded-[7px] px-3 text-2 font-medium text-gray-12 hover:bg-foreground/[0.06] mobile:inline-flex">Run locally</a>
          <Link href="/app" className="weft-press inline-flex h-8 items-center gap-1 rounded-[7px] bg-gray-12 pr-2.5 pl-3 text-2 font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.2)] hover:bg-gray-12/90">
            Open the demo <ChevronRight className="size-4" strokeWidth={1.5} />
          </Link>
        </div>
      </Container>
    </header>
  );
}

// ---- hero ------------------------------------------------------------------------------------------------------

export function Hero({ clock }: { clock: { now: string; rate: number } }) {
  return (
    <section className="relative overflow-hidden">
      <LoomField className={`pointer-events-none absolute inset-y-0 right-0 hidden h-[620px] w-[70%] tablet:block ${css.loomFade}`} />
      <Container className="relative flex flex-col gap-8 pt-14 pb-12 tablet:gap-11 tablet:pt-20">
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] leading-5 font-medium text-gray-10">
          <span>Simulated clock at Larkspur Robotics (demo):</span>
          <span className="text-gray-12"><SimClockTicker now={clock.now} rate={clock.rate} /></span>
        </p>
        <div className="flex max-w-[900px] flex-col gap-5">
          <h1 className="text-[32px] leading-[1.1] font-medium tracking-[-0.01em] text-gray-12 tablet:text-[40px] laptop:text-hero">
            Payroll and people ops,<br />
            run by an agent that <span className="weft-hatch-strong text-accent-9">asks first</span>.
          </h1>
          <p className="max-w-[600px] text-4 leading-[27px] text-gray-a11">
            Weft is an open-source HRIS, payroll and benefits platform. Its agent reads tax notices, checks every payroll
            for anomalies and onboards new hires, then waits for a person before anything moves money or reaches an agency.
            It runs on one fictional company, and every agency, bank and vendor is a simulator in the repo.
          </p>
        </div>
        <div className="flex flex-col gap-3 mobile:flex-row mobile:items-center">
          <div className="w-full mobile:w-[300px]"><CopyCommand command="pnpm install && pnpm dev" /></div>
          <Link href="/app" className="weft-press inline-flex h-11 items-center justify-center gap-2 rounded-[9px] bg-accent-9 px-5 text-3 font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.25)] hover:bg-accent-10">
            Open the demo <ArrowRight className="size-4" strokeWidth={1.5} />
          </Link>
          <a href="#run" className="inline-flex items-center justify-center gap-2 text-2 text-gray-11 hover:text-gray-12 mobile:ml-2">
            <span className="inline-flex size-7 items-center justify-center rounded-full bg-gray-3"><Workflow className="size-3.5" strokeWidth={1.5} /></span>
            See one run, step by step
          </a>
        </div>
        <ProductFrame />
      </Container>
    </section>
  );
}

/** An original mini UI of the hero flow (SPEC 12 GP1): the proposal card and the agent panel beside it. */
function ProductFrame() {
  const diff = [
    ["CA UI rate", "3.4%", "1.5%"],
    ["Effective", "Jan 1, 2026", "Jan 1, 2026"],
    ["Account", "000-4817-2", "000-4817-2"],
    ["Employees affected", "22", "22"],
  ];
  const steps = ["notices.get", "tax.rate_change_impact", "tax.update_rate (proposed)", "notices.send_response (proposed)"];
  return (
    <div id="run" className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card shadow-product">
      <div className="flex h-10 items-center gap-2 border-b border-border bg-gray-1 px-3 text-1 text-gray-10">
        <WeaveMark size={16} />
        <span className="font-medium text-gray-12">Larkspur Robotics (demo)</span>
        <ChevronRight className="size-3" strokeWidth={1.5} />
        <span>Inbox</span>
        <span className="ml-auto rounded-full bg-amber-3 px-2 py-0.5 text-0 font-medium text-amber-11">Simulated</span>
      </div>
      <div className="grid laptop:grid-cols-[200px_1fr_320px]">
        <aside className="hidden flex-col gap-0.5 border-r border-border bg-[#fafafa] p-2 text-2 laptop:flex" aria-hidden>
          {["Home", "Inbox", "Payroll", "People", "Taxes & Compliance", "Routines", "Audit log", "Simulators"].map((n) => (
            <span key={n} className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${n === "Inbox" ? "bg-[#efefef] font-medium text-gray-12" : "text-gray-11"}`}>
              {n}{n === "Inbox" ? <span className="rounded-full bg-accent-9 px-1.5 text-0 font-medium text-white">2</span> : null}
            </span>
          ))}
        </aside>
        <div className="flex min-w-0 flex-col gap-4 p-4 tablet:p-6">
          <div className="flex flex-col gap-1">
            <span className="text-1 font-medium text-gray-10">Proposal from Agency notice handling</span>
            <span className="text-[17px] leading-6 font-medium text-gray-12">Update the CA UI rate from the EDD revised notice</span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[320px] text-left text-2">
              <thead className="bg-gray-2 text-1 text-gray-10">
                <tr><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Before</th><th className="px-3 py-2 font-medium">After</th></tr>
              </thead>
              <tbody>
                {diff.map(([f, b, a]) => (
                  <tr key={f} className="border-t border-border">
                    <td className="px-3 py-2 text-gray-11">{f}</td>
                    <td className="px-3 py-2 text-gray-12 tabular-nums">{b}</td>
                    <td className={`px-3 py-2 tabular-nums ${a !== b ? "font-medium text-accent-11" : "text-gray-12"}`}>{a}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-1 text-gray-10">
            <span className="rounded-full bg-gray-3 px-2 py-0.5 font-medium text-gray-11">R2</span>
            <span>Reversible with one click</span>
            <span className="ml-auto flex gap-2">
              <span className="inline-flex h-8 items-center rounded-md bg-white px-3 text-2 font-medium text-gray-12 shadow-[var(--shadow-border)]">Deny</span>
              <span className="inline-flex h-8 items-center rounded-md bg-gray-12 px-3 text-2 font-medium text-white">Approve</span>
            </span>
          </div>
        </div>
        <div className="hidden flex-col gap-3 border-l border-border bg-gray-1 p-4 text-2 laptop:flex">
          <span className="flex items-center gap-1.5 text-1 font-medium text-accent-9"><MousePointer2 className="size-3.5" strokeWidth={1.5} /> Weft agent</span>
          <p className="leading-[22px] text-gray-a11">
            A CA EDD revised rate notice (DE 2088) arrived. I matched it to account 000-4817-2, worked out the effect on
            this year&apos;s employer SUI, and drafted the rate change and a reply to the agency. Both are waiting for you.
          </p>
          <ul className="flex flex-col gap-1.5 font-mono text-1 text-gray-10">
            {steps.map((s) => <li key={s} className="flex items-center gap-1.5"><CircleCheck className="size-3.5 text-green-11" strokeWidth={1.5} />{s}</li>)}
          </ul>
          <span className="weft-shimmer text-1">Waiting for approval in the Inbox</span>
        </div>
      </div>
    </div>
  );
}

// ---- simulators marquee ------------------------------------------------------------------------------------------

const SIMULATORS: { label: string; icon: typeof Landmark }[] = [
  { label: "IRS (sim)", icon: Landmark },
  { label: "CA EDD (sim)", icon: Building2 },
  { label: "NY DTF (sim)", icon: Building2 },
  { label: "NY DOL (sim)", icon: Building2 },
  { label: "TX TWC (sim)", icon: Building2 },
  { label: "CO DOR (sim)", icon: Building2 },
  { label: "CO CDLE (sim)", icon: Building2 },
  { label: "Sim Federal Credit Union ACH", icon: Banknote },
  { label: "Identity provider (sim)", icon: KeyRound },
  { label: "Laptop vendor (sim)", icon: Laptop },
  { label: "Team chat (sim)", icon: MessageSquare },
  { label: "Juniper Mutual (sim)", icon: HeartPulse },
  { label: "Tidewater Retirement (sim)", icon: PiggyBank },
];

export function SimulatorsMarquee() {
  const items = [...SIMULATORS, ...SIMULATORS];
  return (
    <section id="simulators" className="scroll-mt-16 border-y border-border bg-background">
      <Container className="flex flex-col gap-3 py-5 laptop:flex-row laptop:items-center laptop:gap-10">
        <p className="max-w-sm shrink-0 text-2 font-book text-gray-10">Runs against simulators in this repo, never real agencies or banks</p>
        <div className={`min-w-0 flex-1 overflow-hidden ${css.marquee}`}>
          <ul className={`${css.track} gap-10`} aria-label="Simulators">
            {items.map((s, i) => (
              <li key={i} aria-hidden={i >= SIMULATORS.length} className="flex shrink-0 items-center gap-2 text-2 font-medium whitespace-nowrap text-gray-11">
                <s.icon className="size-4" strokeWidth={1.5} />{s.label}
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}

// ---- section heading -----------------------------------------------------------------------------------------------

function SectionHeading({ lead, rest, id }: { lead: string; rest: string; id?: string }) {
  return (
    <h2 id={id} className="weft-rule max-w-[860px] scroll-mt-20 pl-6 text-[28px] leading-[34px] font-book tracking-[-0.35px] tablet:text-8">
      <span className="text-gray-12">{lead}</span> <span className="text-gray-10">{rest}</span>
    </h2>
  );
}

// ---- how it works --------------------------------------------------------------------------------------------------

const STEPS = [
  {
    n: "01", title: "Seed a company",
    body: "One command builds Larkspur Robotics (demo): 48 employees across four states, three contractors, benefits, tax accounts and an open payroll draft. The same seed gives the same bytes every time.",
  },
  {
    n: "02", title: "Let the agent work",
    body: "Routines start on an event or a schedule. A tax notice lands, a payroll deadline nears, an offer is accepted, and the agent reads, checks and drafts the work on a simulated clock.",
  },
  {
    n: "03", title: "Approve what matters",
    body: "Anything that moves money, files with an agency or changes a rate arrives in your Inbox as a proposal, with the diff, the evidence and an undo wherever one exists.",
  },
];

export function HowItWorks() {
  return (
    <section className="py-12 tablet:py-16 laptop:py-24">
      <Container className="flex flex-col gap-12 laptop:gap-16">
        <SectionHeading id="how-it-works" lead="One fictional company, wired end to end." rest="Seed it, let the agent work, and sign off on what matters." />
        <ol className="grid gap-10 tablet:grid-cols-3 tablet:gap-12">
          {STEPS.map((s) => (
            <li key={s.n} className="weft-rule flex flex-col gap-3 pl-6">
              <span className="font-mono text-[13px] text-gray-10">{s.n}</span>
              <h3 className="text-4 font-medium tracking-[-0.045px] text-gray-12">{s.title}</h3>
              <p className="text-3 text-gray-11">{s.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}

// ---- agent island --------------------------------------------------------------------------------------------------

const GUARDS = [
  { icon: ShieldCheck, title: "Proposals, not surprises", body: "The agent has no approve tool. Every write above the risk line waits for a person, and a decision is checked again when it runs." },
  { icon: ScrollText, title: "Untrusted text stays quarantined", body: "A run that reads a notice or a message is marked tainted. From then on it can only propose; it never sends on its own." },
  { icon: Undo2, title: "A log you can verify", body: "Each action lands in a hash-chained log you can check from the Audit page, with one-click undo for changes that can be reversed." },
];

export function AgentIsland() {
  return (
    <section id="agent" className="scroll-mt-16 pb-12 tablet:pb-16 laptop:pb-24">
      <Container>
        <div className="dark flex flex-col gap-10 rounded-xl bg-island p-6 text-gray-12 shadow-card tablet:p-8 laptop:flex-row laptop:gap-10 laptop:p-12">
          <div className="flex flex-col gap-4 laptop:w-[34%]">
            <span className="flex items-center gap-1.5 text-2 font-book text-[var(--accent-8)]"><MousePointer2 className="size-4" strokeWidth={1.5} /> The Weft agent</span>
            <h2 className="text-[28px] leading-9 font-medium tracking-[-0.21px] text-[#eeeeee]">It drafts. You decide.</h2>
            <p className="text-3 text-[#a0a0a0]">
              The harness, not the model, keeps the agent honest: a small set of strict tools, budgets per run, a spend
              ledger, and checklists that decide when a routine is done. The default model is a small, cheap one on purpose.
            </p>
            <Link href="/app/inbox" className="weft-press mt-2 inline-flex h-10 w-fit items-center gap-1 rounded-lg bg-white px-4 text-2 font-medium text-[#202020] hover:bg-white/90">
              See the Inbox <ChevronRight className="size-4" strokeWidth={1.5} />
            </Link>
          </div>
          {GUARDS.map((g) => (
            <div key={g.title} className="flex flex-col gap-3 border-t border-dotted border-accent-9/60 pt-6 laptop:flex-1 laptop:border-t-0 laptop:border-l laptop:pt-0 laptop:pl-8">
              <span className="flex size-12 items-center justify-center rounded-xl bg-[#3a3a3a] shadow-[inset_0_1px_0_rgba(255,255,255,.1)]"><g.icon className="size-5 text-white" strokeWidth={1.5} /></span>
              <h3 className="text-3 font-medium text-[#eeeeee]">{g.title}</h3>
              <p className="text-3 text-[#a0a0a0]">{g.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

// ---- stats ----------------------------------------------------------------------------------------------------------

export function StatsTiles({ stats }: { stats: LandingStats }) {
  const fmt = new Intl.NumberFormat("en-US");
  const tiles = [
    { value: stats.employees, label: "synthetic employees" },
    { value: stats.simulatedAgencies, label: "simulated agencies" },
    { value: stats.runsLogged, label: "agent runs logged" },
    { value: stats.realAgenciesContacted, label: "real agencies contacted" },
  ];
  return (
    <section className="pb-12 tablet:pb-16 laptop:pb-24">
      <Container className="flex flex-col gap-12">
        <SectionHeading id="numbers" lead="Numbers from this running demo." rest={stats.source === "live" ? "Read live from GET /v1/stats." : "The API is not reachable, so these are the seed's numbers."} />
        <dl data-testid="marketing-stats" data-source={stats.source} className="grid grid-cols-2 border-t border-l border-border laptop:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="flex min-h-[132px] flex-col justify-between gap-6 border-r border-b border-border p-4 tablet:min-h-[176px] tablet:p-6">
              <dt className="order-2 text-2 text-gray-10">{t.label}</dt>
              <dd className="order-1 text-[36px] leading-none font-medium tracking-[-0.02em] text-gray-12 tabular-nums tablet:text-[48px]">{fmt.format(t.value)}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}

// ---- CTA band and footer --------------------------------------------------------------------------------------------

export function CtaBand() {
  return (
    <section className="pb-12 tablet:pb-16 laptop:pb-24">
      <Container>
        <div className="relative flex flex-col overflow-hidden rounded-3xl border border-gray-3 bg-ink-surface laptop:flex-row">
          <div className="relative z-10 flex flex-col gap-5 p-6 tablet:p-10 laptop:w-[55%] laptop:p-16">
            <h2 className="text-[30px] leading-9 font-book tracking-[-0.03em] text-white tablet:text-[40px] tablet:leading-[48px]">
              Run a whole company<br /><span className="weft-hatch text-gray-9">on your own laptop.</span>
            </h2>
            <p className="max-w-[460px] text-4 text-white/80">
              Clone it, seed it and watch the agent work against simulators. The scripted provider needs no key; add one
              when you want a real model in the loop.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Link href="/app" className="weft-press inline-flex h-10 items-center rounded-lg bg-white px-4 text-2 font-medium text-[#202020] hover:bg-white/90">Open the demo</Link>
              <code className="font-mono text-2 text-white/70">pnpm dev</code>
            </div>
          </div>
          <WovenBands className="absolute inset-y-0 right-0 hidden h-full w-[52%] laptop:block" />
          <WovenBands idPrefix="cta-sm" className="h-[150px] w-full laptop:hidden" />
        </div>
      </Container>
    </section>
  );
}

const FOOTER = [
  { head: "Product", links: [{ href: "#how-it-works", label: "How it works" }, { href: "#agent", label: "Agent" }, { href: "#simulators", label: "Simulators" }, { href: "/app", label: "Open the demo" }] },
  { head: "Developers", links: [{ href: "#run", label: "One run, step by step" }, { href: "#numbers", label: "Live numbers" }, { href: "/app/routines", label: "Routines" }, { href: "/app/audit", label: "Audit log" }] },
  { head: "Notice", links: [{ href: "#simulators", label: "Every agency is simulated" }, { href: "#numbers", label: "Demo data is fictional" }] },
];

export function Footer() {
  return (
    <footer className="overflow-hidden border-t border-border">
      <Container className="grid gap-10 pt-12 pb-8 laptop:grid-cols-[350px_1fr]">
        <div className="flex flex-col gap-3">
          <Wordmark />
          <p className="max-w-[280px] text-2 text-gray-10">Open-source payroll and HR with an agent that asks first. Synthetic data only.</p>
        </div>
        <div className="grid grid-cols-2 gap-8 tablet:grid-cols-3">
          {FOOTER.map((c) => (
            <div key={c.head} className="flex flex-col gap-3">
              <span className="text-2 font-book text-gray-12">{c.head}</span>
              {c.links.map((l) => <a key={l.label} href={l.href} className="text-2 text-gray-10 hover:text-gray-12">{l.label}</a>)}
            </div>
          ))}
        </div>
        <p className="text-1 text-gray-10 laptop:col-span-2">Weft contributors, Apache-2.0. Every person and company shown is fictional and marked (demo).</p>
      </Container>
      <div aria-hidden className={`${css.footerWord} mx-auto max-w-[1280px] px-4 select-none laptop:px-8`}>weft</div>
    </footer>
  );
}
