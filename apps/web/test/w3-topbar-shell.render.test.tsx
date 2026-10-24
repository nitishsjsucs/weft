// The top bar, sidebar head and agent panel header as they render (research/wave3/topbar-design.md 5.3 to 5.8 and 7;
// owner w3-topbar-shell). A static render with the data hooks stubbed: the scripted provider, the seeded clock
// (Monday 8:30 AM PT, paused) and Vic as the signed-in human. The e2e spec (GP19) measures the same bar in a browser.
// The pill holds the clock and Viewing as; the model segment (TID.providerBadge) is no longer in the bar.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TID, W3_SHELL_TID, W3_TOPBAR_SHELL_DOM } from "@weft/contracts";
import { AgentProvider } from "../src/components/app/agent-context";
import { Header } from "../src/components/app/shell/header";
import { Sidebar } from "../src/components/app/shell/sidebar";
import { AgentPanel } from "../src/components/app/agent/agent-panel";
import { BreadcrumbProvider } from "../src/components/app/shell/crumbs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/people/wrk_0001",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api/hooks")>();
  const q = (data: unknown) => ({ data, error: null, loading: false, reload: () => {} });
  const now = "2026-10-26T15:30:00.000Z";
  return {
    ...actual,
    usePrincipal: () => "usr_dana",
    useHealth: () => q({ ok: true, provider: { id: "scripted", model: "scripted", label: "Scripted, no model", live: false }, clock: { now, rate: 0 } }),
    useSimClock: () => q({ now, rate: 0 }),
    useGet: (path: string) => q(path === "/v1/offers" ? { data: [] } : undefined),
    usePendingCount: () => 3,
  };
});

const shell = (node: ReactNode) => renderToStaticMarkup(<AgentProvider><BreadcrumbProvider>{node}</BreadcrumbProvider></AgentProvider>);
const bar = (sidebarVisible = true) =>
  shell(<Header sidebarVisible={sidebarVisible} sidebarExpanded={sidebarVisible} onToggleSidebar={() => {}} onOpenSearch={() => {}} />);

/** Opening tags of every element carrying `attr`, in document order. */
const tagsWith = (html: string, attr: string) => [...html.matchAll(new RegExp(`<[a-z]+[^>]*\\s${attr}(=|\\s|>)[^>]*>`, "g"))].map((m) => m[0]);
const attrOf = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

describe("the top bar", () => {
  it("orders the pill clock, then Viewing as, keeps the wave 1 test ids on those controls, and shows no model", () => {
    const html = bar();
    const segs = tagsWith(html, "data-seg");
    expect(segs.map((t) => attrOf(t, "data-testid"))).toEqual([TID.simClock, TID.viewingAs]);
    expect(html).toContain(`role="group" aria-label="Environment" data-testid="${W3_SHELL_TID.envPill}"`);
    // Exactly one divider, hidden from screen readers.
    expect(tagsWith(html, "data-divider").every((t) => attrOf(t, "aria-hidden") === "true")).toBe(true);
    expect(tagsWith(html, "data-divider")).toHaveLength(1);
    // No model chip: no provider badge, no model popover, and neither the provider label nor its model id.
    expect(html).not.toContain(`data-testid="${TID.providerBadge}"`);
    expect(html).not.toContain("data-model-state");
    expect(html).not.toMatch(/>Scripted</);
    expect(html).not.toContain("Model:");
  });

  it("gives every segment the 28 px, radius 6 shape and the inset blue ring", () => {
    for (const t of tagsWith(bar(), "data-seg")) {
      const cls = attrOf(t, "class") ?? "";
      expect(cls).toContain("h-7");
      expect(cls).toContain("rounded-md");
      expect(cls).toContain("text-[13px]");
      expect(cls).toContain("focus-visible:shadow-[inset_0_0_0_2px_var(--blue-9)]");
    }
  });

  it("makes every icon button 32 px at radius 8 (size icon, never icon-sm)", () => {
    const html = bar(false);
    const icons = [/aria-label="Toggle sidebar"/, /aria-label="Search pages, people and payroll runs"/, /aria-label="Toggle agent panel"/];
    const buttons = tagsWith(html, "aria-label").filter((t) => t.startsWith("<button") && icons.some((r) => r.test(t)));
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(attrOf(b, "class")).toContain("size-8 rounded-lg");
      expect(attrOf(b, "class")).not.toContain("size-7");
    }
  });

  it("wires the toggles to what they control", () => {
    const html = bar();
    const side = tagsWith(html, "aria-controls").find((t) => t.includes("Toggle sidebar"))!;
    expect(attrOf(side, "aria-controls")).toBe(W3_TOPBAR_SHELL_DOM.sidebar);
    expect(attrOf(side, "aria-expanded")).toBe("true");
    const agent = tagsWith(html, "aria-controls").find((t) => t.includes("Toggle agent panel"))!;
    expect(attrOf(agent, "aria-controls")).toBe(W3_TOPBAR_SHELL_DOM.agentPanel);
    expect(attrOf(agent, "aria-pressed")).toBe("false");
    expect(attrOf(agent, "data-testid")).toBe(W3_SHELL_TID.agentToggle);
  });

  it("shows the search icon only while the sidebar (which carries search) is hidden", () => {
    expect(bar(true)).not.toContain("Search pages, people and payroll runs");
    expect(bar(false)).toContain('aria-label="Search pages, people and payroll runs"');
    expect(bar(false)).toContain('aria-keyshortcuts="Meta+K Control+K"');
  });

  it("carries the full meaning in accessible names and has no title tooltips", () => {
    const html = bar();
    const label = (testid: string) => attrOf(tagsWith(html, "data-testid").find((t) => attrOf(t, "data-testid") === testid)!, "aria-label");
    expect(label(TID.simClock)?.replace(/[  ]/g, " ")).toBe("Clock: Monday, October 26, 8:30 AM Pacific");
    expect(label(TID.viewingAs)).toBe("Viewing as Vic Akisole. Switches the signed-in person, dev auth only");
    expect(html).not.toMatch(/\stitle="/);
    // One polite live region, for persona switches.
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("uses color only on the amber avatar: no status dot, no badge washes, no accent", () => {
    const html = bar();
    expect(html).not.toMatch(/bg-(green|amber|blue|red)-3\b/);
    expect(html).not.toContain("accent-9");
    expect(html).not.toContain("data-state-dot");
    expect(tagsWith(html, "data-avatar").map((t) => attrOf(t, "class"))).toEqual([expect.stringContaining("bg-[var(--demo-bg)]")]);
  });

  it("tiers by the header's container, not the window: the @container sits on a wrapper", () => {
    const html = bar();
    expect(html).toMatch(/^<div class="@container[^"]*"><header /);
    expect(html).toContain("@min-[760px]:inline");
    expect(html).toContain("@min-[480px]:inline");
  });

  it("shows the record id in mono until the detail view registers its title", () => {
    const html = bar();
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toMatch(/href="\/app\/people"[^>]*>People</);
    expect(html).toMatch(/aria-current="page" class="[^"]*font-mono[^"]*">wrk_0001</);
  });
});

describe("the sidebar head", () => {
  const html = shell(<Sidebar id={W3_TOPBAR_SHELL_DOM.sidebar} onOpenSearch={() => {}} />);

  it("has the sidebar id, a two-line workspace row and search with a New agent thread button", () => {
    expect(html).toContain(`id="${W3_TOPBAR_SHELL_DOM.sidebar}"`);
    expect(html).toContain(">Larkspur Robotics<");
    expect(html).toContain(">Admin<");
    expect(html).not.toContain("Demo workspace");
    expect(html).toContain(`data-testid="${W3_SHELL_TID.sidebarSearch}"`);
    expect(html).toContain(`data-testid="${W3_SHELL_TID.newThread}"`);
    expect(html).toContain('aria-label="New agent thread"');
    // One kbd chip for the whole shortcut.
    expect(html.match(/<kbd/g)).toHaveLength(1);
  });

  it("keeps one pill style (the Inbox count), no trailing nav labels and no inert group chevrons", () => {
    expect(html).toContain('aria-label="3 pending"');
    expect(html.match(/rounded-full bg-accent-9/g)).toHaveLength(1);
    expect(html).not.toMatch(/simulated/i);
    expect(html).not.toContain("lucide-chevron-down");
  });
});

describe("the agent panel header", () => {
  it("uses 32 px buttons and shows the close X only when the panel overlays the page", () => {
    const docked = shell(<AgentPanel id={W3_TOPBAR_SHELL_DOM.agentPanel} />);
    const overlay = shell(<AgentPanel id={W3_TOPBAR_SHELL_DOM.agentPanel} overlay />);
    expect(docked).toContain(`id="${W3_TOPBAR_SHELL_DOM.agentPanel}"`);
    expect(docked).not.toContain("Close agent panel");
    expect(overlay).toContain('aria-label="Close agent panel"');
    for (const b of tagsWith(overlay, "aria-label").filter((t) => /New thread|Close agent panel/.test(t))) expect(attrOf(b, "class")).toContain("size-8");
  });
});
