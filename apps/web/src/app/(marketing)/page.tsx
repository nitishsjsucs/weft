// Landing page `/` (SPEC 11.2): structure after research/design.md 13.1, original copy and art only. Owner: t6-site.
// On Node, stats and the simulated clock are read from the API on each request, with the seed's numbers as the
// fallback. In the static export (Weft on Cloudflare, docs/cloudflare/design.md 3.5) the page is a static asset with the
// snapshot's stats.json and the frozen hosted clock; a leased visitor's browser then refreshes both.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { HOSTED_CLOCK } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { HostedClock, HostedStatsTiles } from "@/components/marketing/hosted-landing";
import { loadLanding, type LandingStats } from "@/components/marketing/live";
import { AgentIsland, Announcement, CtaBand, Footer, Hero, HowItWorks, Nav, ProductsSection, SimulatorsMarquee, StatsTiles } from "@/components/marketing/sections";
import { readSnapshotStats } from "@/components/marketing/snapshot-stats";
import { STATIC_EXPORT } from "@/lib/static-export";

export const metadata: Metadata = {
  title: "Weft: open-source payroll and HR with an agent that asks first",
  description: "An open-source HRIS, payroll and benefits platform with an agent that drafts the admin work and waits for approval. Synthetic data and in-repo simulators only.",
};

function Landing({ hero, stats }: { hero: ReactNode; stats: ReactNode }) {
  return (
    <>
      <Announcement />
      <Nav />
      <main>
        {hero}
        <SimulatorsMarquee />
        <ProductsSection />
        <HowItWorks />
        <AgentIsland />
        {stats}
        <CtaBand />
      </main>
      <Footer />
    </>
  );
}

export default async function Home() {
  if (STATIC_EXPORT) {
    const stats: LandingStats = readSnapshotStats();
    const clock = { now: HOSTED_CLOCK.at, rate: HOSTED_CLOCK.rate };
    return <Landing hero={<Hero clock={clock} clockSlot={<HostedClock initial={clock} stats={stats} />} />} stats={<HostedStatsTiles initial={stats} />} />;
  }
  // Rendered on each request (the API's live numbers), as `dynamic = "force-dynamic"` did before the static export.
  await connection();
  const { stats, clock } = await loadLanding();
  return <Landing hero={<Hero clock={clock} />} stats={<StatsTiles stats={stats} />} />;
}
