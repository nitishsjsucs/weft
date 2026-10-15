// Landing page `/` (SPEC 11.2): structure after research/design.md 13.1, original copy and art only. Owner: t6-site.
// Stats and the simulated clock are read from the API on each request, with the seed's numbers as the fallback.
import type { Metadata } from "next";
import { loadLanding } from "@/components/marketing/live";
import { AgentIsland, Announcement, CtaBand, Footer, Hero, HowItWorks, Nav, ProductsSection, SimulatorsMarquee, StatsTiles } from "@/components/marketing/sections";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Weft: open-source payroll and HR with an agent that asks first",
  description: "An open-source HRIS, payroll and benefits platform with an agent that drafts the admin work and waits for approval. Synthetic data and in-repo simulators only.",
};

export default async function Home() {
  const { stats, clock } = await loadLanding();
  return (
    <>
      <Announcement />
      <Nav />
      <main>
        <Hero clock={clock} />
        <SimulatorsMarquee />
        <ProductsSection />
        <HowItWorks />
        <AgentIsland />
        <StatsTiles stats={stats} />
        <CtaBand />
      </main>
      <Footer />
    </>
  );
}
