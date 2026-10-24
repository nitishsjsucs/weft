// Weft reads like a company workspace: no "(demo)" or "(sim)" markers, no demo wording, and connector modes named as
// a vendor integration names them (Sandbox or Connected). The landing page keeps exactly one plain statement that the
// company is fictional and the outside world simulated, so it never reads as a customer story.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntegrationCard } from "@weft/contracts";
import { modeLabel } from "../src/components/app/integrations/integrations-view";
import { sandboxLabel } from "../src/components/app/screening/offer-screening";
import { ALL_NAV } from "../src/components/app/nav";
import { initials } from "../src/components/app/format";
import { FALLBACK_STATS } from "../src/components/marketing/live";
import {
  AgentIsland, Announcement, CtaBand, FICTIONAL_NOTE, Footer, Hero, HowItWorks, Nav, ProductsSection, SimulatorsMarquee, StatsTiles, statsNote,
} from "../src/components/marketing/sections";

const card = (mode: "simulated" | "real", health = "ok") => ({ status: { mode, health } }) as unknown as Pick<IntegrationCard, "status">;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("connector modes", () => {
  it("a simulator-backed connector reads Sandbox; a real adapter reads Connected, or Real, disabled behind the live flags", () => {
    expect(modeLabel(card("simulated"))).toEqual({ text: "Sandbox", tone: "gray" });
    expect(modeLabel(card("real"))).toEqual({ text: "Connected", tone: "green" });
    expect(modeLabel(card("real", "permission_gap"))).toEqual({ text: "Real, disabled", tone: "amber" });
  });
  it("a sandbox background check says so, and HireRight keeps its honest API note", () => {
    expect(sandboxLabel("checkr")).toBe("Sandbox");
    expect(sandboxLabel("hireright")).toBe("Sandbox, API shape not published");
  });
});

describe("names of record", () => {
  it("avatars read the initials of the plain name", () => {
    expect(initials("Vic Akisole")).toBe("VA");
    expect(initials("Noor Castellanos")).toBe("NC");
  });
});

describe("the sidebar nav", () => {
  it("carries no Simulated trailing labels: the Inbox count is the only badge", () => {
    expect(ALL_NAV.filter((n) => n.badge).map((n) => [n.slug, n.badge])).toEqual([["inbox", "inbox"]]);
    expect(ALL_NAV.find((n) => n.slug === "simulators")?.label).toBe("Simulators");
  });
});

describe("the landing page", () => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(Announcement), createElement(Nav), createElement(Hero, { clock: { now: "2026-10-26T15:30:00.000Z", rate: 0 } }),
    createElement(SimulatorsMarquee), createElement(ProductsSection), createElement(HowItWorks), createElement(AgentIsland),
    createElement(StatsTiles, { stats: FALLBACK_STATS }), createElement(CtaBand), createElement(Footer)));
  const page = text(html);

  it("says once, plainly, that the company is fictional and the agencies, bank and vendors simulated", () => {
    expect(FICTIONAL_NOTE).toBe("Larkspur Robotics and everyone shown are fictional; every agency, bank and vendor is simulated.");
    expect(page.split(FICTIONAL_NOTE)).toHaveLength(2);
    expect(page.match(/fictional/gi)).toHaveLength(1);
    expect(page.match(/simulated/gi)).toHaveLength(1);
  });
  it("has no name markers, demo wording or Simulated pills elsewhere", () => {
    expect(page).not.toMatch(/\((demo|sim)\)|\bdemo\b|synthetic|Simulated clock/i);
    expect(page).toContain("Clock at Larkspur Robotics:");
    expect(page).toContain("Open the app");
    expect(page).toContain("Weft contributors, Apache-2.0.");
  });
  it("names each stats source without calling the database a demo", () => {
    expect(statsNote("live")).toBe("Counted from the database as it runs.");
    expect(statsNote("snapshot")).toBe("Counted from the company's seeded database.");
    expect(page).toContain("real agencies contacted");
  });
});
