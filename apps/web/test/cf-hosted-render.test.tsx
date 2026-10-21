// The hosted shell as it renders (track cf5-web; docs/cloudflare/design.md 6.2 and 10), with NEXT_PUBLIC_WEFT_HOSTED
// on: the showcase and leased banners, the Platform and model comparison pages, the model switch, the hosted sidebar
// and the agent panel's fictional-data notice. Static renders with the session state and the hosted reads stubbed.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../../../packages/contracts/src/ext/cf-hosted";
import type { ModelComparisonRow, PlatformReadout } from "../../../packages/contracts/src/ext/cf-extras";

vi.mock("@/lib/hosted/flags", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/hosted/flags")>()), HOSTED: true }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/simulators/",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const state = vi.hoisted(() => ({ status: null as SessionStatus | null, blocked: null as unknown, data: null as unknown, error: null as string | null, errorStatus: null as number | null, errorCode: null as string | null }));
vi.mock("../src/components/hosted/use-hosted", () => ({
  useHostedState: () => ({ status: state.status, loaded: true, error: state.error, errorStatus: state.errorStatus, errorCode: state.errorCode, ended: null, blocked: state.blocked, startAsk: 0, startReason: null, grantAsk: null }),
  useNow: () => Date.parse("2026-10-26T16:00:00.000Z"),
  useHostedGet: () => ({ data: state.data, error: null, loading: false, reload: () => {} }),
}));
vi.mock("@/lib/api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api/hooks")>();
  const q = (data: unknown) => ({ data, error: null, loading: false, reload: () => {} });
  return { ...actual, usePrincipal: () => "usr_dana", useGet: () => q(undefined), usePendingCount: () => 0, useHealth: () => q(undefined), useSimClock: () => q({ now: "2026-10-26T15:30:00.000Z", rate: 0 }) };
});

const { HostedBanner } = await import("../src/components/hosted/hosted-banner");
const { PlatformView } = await import("../src/components/hosted/platform-view");
const { ModelsView } = await import("../src/components/hosted/models-view");
const { ModelSwitchSection } = await import("../src/components/hosted/model-switch");
const { Sidebar } = await import("../src/components/app/shell/sidebar");
const { AgentPanel } = await import("../src/components/app/agent/agent-panel");
const { AgentProvider } = await import("../src/components/app/agent-context");
const { BreadcrumbProvider } = await import("../src/components/app/shell/crumbs");

const status = (p: Partial<SessionStatus> = {}): SessionStatus => ({
  world: "showcase", lease: null, grantExpiresAt: null, level: 0, pool: { size: 2, free: 1, waitlist: 0 }, provider: { id: "openai", reason: "default" }, agentEnabled: true, ...p,
});
const lease = { slot: "slot-1", gen: 3, expiresAt: "2026-10-26T18:30:00.000Z", idleExpiresAt: "2026-10-26T16:42:00.000Z", resetsLeft: 3 };
const shell = (n: ReactNode) => renderToStaticMarkup(<AgentProvider><BreadcrumbProvider>{n}</BreadcrumbProvider></AgentProvider>);

describe("the hosted banner", () => {
  it("renders nothing before the session is read", () => {
    state.status = null;
    expect(renderToStaticMarkup(<HostedBanner />)).toBe("");
  });
  it("says so when the session cannot be read: the account's request cap (a platform 429) or the API down", () => {
    state.status = null; state.error = "Too Many Requests"; state.errorStatus = 429;
    expect(renderToStaticMarkup(<HostedBanner />)).toContain("shared request allowance");
    state.errorCode = "RATE_LIMITED";
    expect(renderToStaticMarkup(<HostedBanner />)).toContain("Too many requests from this network");
    state.errorCode = null; state.errorStatus = 502;
    expect(renderToStaticMarkup(<HostedBanner />)).toContain("not answering right now");
    state.error = null; state.errorStatus = null;
  });
  it("offers Start my demo company on the shared showcase", () => {
    state.status = status(); state.blocked = null;
    const html = renderToStaticMarkup(<HostedBanner />);
    expect(html).toContain('data-world="showcase"');
    expect(html).toContain("read only");
    expect(html).toContain('data-testid="hosted-start-cta"');
    expect(html).toContain("Start my demo company");
  });
  it("shows a refused lease instead, and no Start button at level 3", () => {
    state.status = status({ level: 3 }); state.blocked = { status: "closed", level: 3 };
    const html = renderToStaticMarkup(<HostedBanner />);
    expect(html).toContain("paused for today");
    expect(html).not.toContain("hosted-start-cta");
    state.blocked = null;
  });
  it("counts down the visitor's own lease (the earlier deadline) with the fictional-data notice", () => {
    state.status = status({ world: "slot", lease });
    const html = renderToStaticMarkup(<HostedBanner />);
    expect(html).toContain('data-world="slot"');
    expect(html).toContain('data-slot="slot-1"');
    expect(html).toContain(">42 min left<");
    expect(html).toContain("Please do not type real personal data.");
  });
  it("says when new runs fall back to the scripted provider", () => {
    state.status = status({ world: "slot", lease, provider: { id: "scripted", reason: "budget" } });
    expect(renderToStaticMarkup(<HostedBanner />)).toContain("budget is used up, so new agent runs use the scripted provider");
  });
});

describe("the Platform page", () => {
  it("shows spend against the caps, neurons, restores, leases, dead letters and each share", () => {
    const r: PlatformReadout = {
      day: "2026-10-26", level: 1, dollars: { spentUsd: 0.0012, dayCapUsd: 2, runCapUsd: 0.1 }, neurons: { used: 210, cap: 5000 }, restoresLeft: 2,
      leases: { active: 1, pool: 2, waitlist: 0 }, deadLetters: 0, lastSweepAt: "2026-10-26T15:45:00.000Z",
      shares: { doRowsWritten: { used: 45000, share: 60000 }, workerRequests: { used: 300, share: 60000 } },
    };
    state.data = r;
    const html = renderToStaticMarkup(<PlatformView />);
    expect(html).toContain('data-testid="platform-readout"');
    expect(html).toContain("$0.0012 of $2.00");
    expect(html).toContain("Each run is capped at $0.10.");
    expect(html).toContain("210 of 5,000 (4%)");
    expect(html).toContain("1 of 2");
    expect(html).toContain("15:45 UTC");
    expect(html).toContain("Durable Object rows written");
    expect(html).toContain("45,000 of 60,000 (75%)");
    expect(html).toContain("Level 1");
  });
});

describe("the model comparison page", () => {
  it("lists runs per provider and model", () => {
    const rows: ModelComparisonRow[] = [
      { provider: "openai", model: "gpt-5.6-luna", runs: 12, avgSteps: 4.25, groundedRate: 0.92, avgCostUsdMicros: 3100, avgNeurons: 0, p50LatencyMs: 4200, outcomes: { done: 11, refused: 1 } },
      { provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", runs: 3, avgSteps: 5, groundedRate: null, avgCostUsdMicros: 900, avgNeurons: 380, p50LatencyMs: 640, outcomes: { done: 3 } },
    ];
    state.data = rows;
    const html = renderToStaticMarkup(<ModelsView />);
    expect(html).toContain('data-provider="openai"');
    expect(html).toContain("OpenAI gpt-5.6-luna");
    expect(html).toContain("Workers AI gpt-oss-120b");
    expect(html).toContain("92%");
    expect(html).toContain("Not measured");
    expect(html).toContain("$0.0031");
    expect(html).toContain("4.2 s");
    expect(html).toContain("done 11, refused 1");
  });
});

describe("the model switch", () => {
  it("is live in the visitor's own world and marks the world's choice", () => {
    state.status = status({ world: "slot", lease, provider: { id: "workers_ai", reason: "world" } });
    const html = renderToStaticMarkup(<ModelSwitchSection />);
    expect(html).toContain("New runs use Workers AI gpt-oss-120b.");
    expect(html).toMatch(/data-provider="workers_ai"[^>]*checked=""/);
    expect(html).not.toContain("disabled");
  });
  it("is read only on the showcase", () => {
    state.status = status();
    const html = renderToStaticMarkup(<ModelSwitchSection />);
    expect(html).toContain("Start your demo company to choose the model.");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
    expect(html).toMatch(/data-provider="null"[^>]*checked=""/);
  });
});

describe("the hosted shell around the app", () => {
  it("lists Platform and Model comparison in the sidebar", () => {
    const html = shell(<Sidebar id="sidebar" onOpenSearch={() => {}} />);
    expect(html).toContain('href="/app/platform"');
    expect(html).toContain('href="/app/models"');
  });
  it("puts the fictional-data notice in the agent panel", () => {
    expect(shell(<AgentPanel />)).toContain('data-testid="hosted-fictional"');
  });
});
