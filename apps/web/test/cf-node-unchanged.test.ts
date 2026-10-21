// The Node app stays exactly as it was (track cf5-web): without WEFT_STATIC_EXPORT and NEXT_PUBLIC_WEFT_HOSTED the
// Next config is the Node one, the five [id] routes stay rendered on demand, polling is the plain setInterval, the
// client uses the plain fetch, the sidebar has no hosted pages, and the shells pass the real id straight through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/people/wrk_0026/",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.useRealTimers(); });

describe("next.config.ts", () => {
  it("is the Node config without the switches: rewrites to the API, no export settings", async () => {
    vi.stubEnv("WEFT_STATIC_EXPORT", "");
    vi.stubEnv("NEXT_PUBLIC_WEFT_HOSTED", "");
    const c = (await import("../next.config")).default;
    expect(c.output).toBeUndefined();
    expect(c.trailingSlash).toBeUndefined();
    expect(c.pageExtensions).toBeUndefined();
    expect(c.env).toBeUndefined();
    expect(await c.rewrites!()).toEqual([{ source: "/api/:path*", destination: "http://127.0.0.1:4070/:path*" }]);
    expect(c).toMatchObject({ agentRules: false, devIndicators: false, compress: false, poweredByHeader: false, transpilePackages: ["@weft/ui", "@weft/contracts"] });
  });
  it("is the static export under WEFT_STATIC_EXPORT=1: no rewrites, trailing slashes, only .tsx pages", async () => {
    vi.stubEnv("WEFT_STATIC_EXPORT", "1");
    vi.stubEnv("NEXT_PUBLIC_WEFT_HOSTED", "");
    const c = (await import("../next.config")).default;
    expect(c).toMatchObject({ output: "export", trailingSlash: true, pageExtensions: ["tsx"], images: { unoptimized: true }, env: { NEXT_PUBLIC_WEFT_STATIC_EXPORT: "1" } });
    expect(c.rewrites).toBeUndefined();
  });
  it("adds the hosted pages' extension on the hosted build, export or next dev", async () => {
    vi.stubEnv("WEFT_STATIC_EXPORT", "1");
    vi.stubEnv("NEXT_PUBLIC_WEFT_HOSTED", "1");
    expect((await import("../next.config")).default.pageExtensions).toEqual(["hosted.tsx", "tsx"]);
    vi.resetModules();
    vi.stubEnv("WEFT_STATIC_EXPORT", "");
    const dev = (await import("../next.config")).default;
    expect(dev.pageExtensions).toEqual(["hosted.tsx", "tsx", "ts", "jsx", "js"]);
    expect(dev.rewrites).toBeDefined();
  });
});

describe("the [id] pages", () => {
  it("export no generateStaticParams on Node, and one `_` shell in the export", async () => {
    vi.stubEnv("WEFT_STATIC_EXPORT", "");
    expect((await import("../src/lib/static-export")).shellStaticParams).toBeUndefined();
    vi.resetModules();
    vi.stubEnv("WEFT_STATIC_EXPORT", "1");
    const { shellStaticParams } = await import("../src/lib/static-export");
    expect(await shellStaticParams!()).toEqual([{ id: "_" }]);
  });
  it("hydrate the shell with `_` (matching its prerendered HTML) and pass a real id straight through", async () => {
    const { useRouteId } = await import("../src/lib/route-id");
    const Probe = ({ id }: { id: string }) => createElement("span", null, useRouteId("people", id));
    expect(renderToStaticMarkup(createElement(Probe, { id: "_" }))).toBe("<span>_</span>");
    expect(renderToStaticMarkup(createElement(Probe, { id: "wrk_0001" }))).toBe("<span>wrk_0001</span>");
  });
  it("render nothing for the shell before the id is known", async () => {
    const { RunRoute, PersonRoute, PayrollRoute, RoutineRoute, OffboardingRoute } = await import("../src/components/app/route-shells");
    for (const C of [RunRoute, PersonRoute, PayrollRoute, RoutineRoute, OffboardingRoute]) expect(renderToStaticMarkup(createElement(C, { id: "_" }))).toBe("");
  });
});

describe("polling and fetch on Node", () => {
  it("startPoller is a plain setInterval", async () => {
    vi.useFakeTimers();
    const { startPoller } = await import("../src/lib/api/hooks");
    let n = 0;
    const p = startPoller(() => { n++; }, 4_000, "/api/v1/agent/runs");
    vi.advanceTimersByTime(20_000);
    expect(n).toBe(5);
    p.stop();
    vi.advanceTimersByTime(20_000);
    expect(n).toBe(5);
  });
  it("apiFetch is the plain fetch, arguments untouched", async () => {
    const seen: unknown[] = [];
    const g = globalThis as Record<string, unknown>;
    const orig = g.fetch;
    g.fetch = async (...a: unknown[]) => { seen.push(a); return new Response("{}"); };
    try {
      const { apiFetch } = await import("../src/lib/api/client");
      await apiFetch("/api/v1/workers", { method: "POST", body: "{}" });
      expect(seen).toEqual([["/api/v1/workers", { method: "POST", body: "{}" }]]);
    } finally { g.fetch = orig; }
  });
  it("the HOSTED switch is off", async () => {
    expect((await import("../src/lib/hosted/flags")).HOSTED).toBe(false);
  });
});

describe("the sidebar", () => {
  it("has no hosted pages on Node; the hosted build appends Platform and Model comparison to Company", async () => {
    const { NAV, navGroups, HOSTED_NAV_ITEMS } = await import("../src/components/app/nav");
    expect(NAV.flatMap((g) => g.items).some((i) => i.slug === "platform" || i.slug === "models")).toBe(false);
    expect(NAV).toBe(navGroups(false));
    const company = navGroups(true).find((g) => g.label === "Company")!;
    expect(company.items.slice(-2)).toEqual(HOSTED_NAV_ITEMS);
    expect(navGroups(true).flatMap((g) => g.items)).toHaveLength(NAV.flatMap((g) => g.items).length + 2);
  });
});
