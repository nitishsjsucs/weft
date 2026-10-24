// The hosted shell on the real stack (design 3.5, 6.1, 6.2 and 6.5), track cf7-integrate: what an unleased visitor
// sees (the shared read-only showcase, Open my workspace, a deep link rendered from its section's shell, the
// security headers), what a leased tab sees (its own slot with no banner and no countdown, the session status), the
// model switch on the Simulators page, and the Platform page's readout. Leased checks use the operator lease, never
// Turnstile. The last case is the app's own Reset workspace data, which keeps the visitor's lease and cookies.
import { bannerWorld, expect, LIVE, pinProvider, test } from "./fixtures";
import { budgetLine, mutationHeadroom, type BudgetReadout } from "./world";
import { HOSTED_COPY, providerLabel } from "../../apps/web/src/components/hosted/copy";

interface Session {
  world: "showcase" | "slot";
  lease: { slot: string; gen: number; expiresAt: string; idleExpiresAt: string; resetsLeft: number } | null;
  grantExpiresAt: string | null;
  level: number;
  pool: { size: number; free: number; waitlist: number };
  provider: { id: "openai" | "workers_ai" | "scripted"; reason: string };
  agentEnabled: boolean;
}

test("an unleased visitor browses the shared read-only showcase; a deep link renders from its shell", async ({ page, consoleErrors }) => {
  const res = await page.goto("/app/");
  expect(res?.status()).toBe(200);
  const headers = res?.headers() ?? {};
  expect(headers["content-security-policy"] ?? "", "CSP on the app shell").toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(await bannerWorld(page)).toBe("showcase");
  await expect(page.getByTestId("hosted-banner")).toContainText(HOSTED_COPY.showcase);
  await expect(page.getByTestId("hosted-start-cta")).toBeVisible();
  const s = (await (await page.request.get("/api/_session")).json()) as Session;
  expect(s).toMatchObject({ world: "showcase", lease: null, grantExpiresAt: null });
  expect(s.pool.size).toBe(2);

  const deep = await page.goto("/app/people/wrk_0026/");
  expect(deep?.status(), "the people shell serves a record deep link").toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lena Brooks");
  expect(await page.evaluate(() => location.pathname)).toBe("/app/people/wrk_0026/");

  // A showcase mutation is refused at the edge with LEASE_REQUIRED, which opens Open my workspace.
  const refused = await page.request.post("/api/v1/sim/clock/advance", { data: { by: "P1D" }, headers: { origin: new URL(page.url()).origin, "x-weft-principal": "usr_dana" } });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe("LEASE_REQUIRED");
  expect(consoleErrors.filter((e) => !/409 POST \/api\/v1\/sim\/clock\/advance/.test(e)), "no console errors").toEqual([]);
});

// The Agent page in the export (README "The Agent page"): one prerendered page that reads its selection from the query,
// so a deep link needs no shell. The showcase is the rich world, so its seeded conversations and routine runs are there;
// nothing here writes, so it costs no lease.
test("the Agent page renders from the export: conversations, background work, a deep link and the hosted composer", async ({ page, consoleErrors }) => {
  const res = await page.goto("/app/agent/");
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("agent-page")).toBeVisible();
  await expect(page.getByTestId("nav-agent")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("agent-composer"), "the side panel stays closed on the Agent page").toHaveCount(0);
  const threads = page.getByTestId("agent-page-thread");
  await expect(threads.first()).toBeVisible();
  await page.getByTestId("agent-page-tab-background").click();
  await expect(page.getByTestId("agent-page-background").first()).toBeVisible();
  await page.getByTestId("agent-page-tab-threads").click();
  await threads.first().click();
  await expect(page).toHaveURL(/\/app\/agent\/\?(run|thread)=/);
  await expect(page.getByTestId("agent-page-turn").first().getByTestId("agent-answer")).toBeVisible();
  const deep = page.url();
  await page.goto(deep);
  expect(new URL(page.url()).search, "the deep link keeps its query").toBe(new URL(deep).search);
  await expect(page.getByTestId("agent-page-turn").first().getByTestId("agent-answer")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(await page.getByTestId("agent-page-title").innerText());
  await expect(page.getByTestId("agent-page-composer")).toBeVisible();
  await expect(page.getByTestId("agent-page").getByTestId("hosted-dictate"), "Dictate sits in the page's composer").toBeVisible();
  expect(consoleErrors, "no console errors").toEqual([]);
});

test("a leased tab reads its own slot: no banner and no countdown, and the session status", async ({ page, operator }) => {
  await page.goto("/app/");
  expect(await bannerWorld(page)).toBe("slot");
  await expect(page.getByTestId("hosted-world")).toHaveAttribute("data-slot", operator.lease.slot);
  await expect(page.getByTestId("hosted-lease-left"), "no lease countdown (Nitish, 2026-10-23)").toHaveCount(0);
  const s = await operator.world.get<Session>("/api/_session");
  // A leased world shows a banner only when there is something to say: a rows-budget limit or a provider note.
  if (s.agentEnabled && !["budget", "neurons", "paused"].includes(s.provider.reason)) await expect(page.getByTestId("hosted-banner")).toHaveCount(0);
  expect(s.world).toBe("slot");
  expect(s.lease).toMatchObject({ slot: operator.lease.slot, gen: operator.lease.gen });
  expect(Date.parse(s.grantExpiresAt ?? ""), "the operator lease carries a fresh human grant").toBeGreaterThan(Date.now());
  expect(s.agentEnabled).toBe(true);
  expect(s.provider).toEqual(LIVE ? { id: s.provider.id, reason: "default" } : { id: "scripted", reason: "world" });
  const health = await operator.world.get<{ runtime: string; seedProfile: string; world: { slot: string; gen: number; mode: string } }>("/api/v1/health");
  expect(health).toMatchObject({ runtime: "cloudflare", seedProfile: "rich", world: { slot: operator.lease.slot, gen: operator.lease.gen, mode: "slot" } });
});

test("the Simulators page shows the model switch, and switching it changes what new runs use", async ({ page, operator }) => {
  await mutationHeadroom(4);
  await page.goto("/app/simulators/");
  const section = page.getByTestId("hosted-model-switch");
  await expect(section).toBeVisible();
  await expect(section.locator('input[name="hosted-model"]')).toHaveCount(4);
  const current = page.getByTestId("hosted-model-current");
  const want = async () => `New runs use ${providerLabel((await operator.world.get<Session>("/api/_session")).provider.id)}.`;
  await expect(current).toContainText(await want());
  try {
    // To the default and back. No run starts in between, so nothing is spent on a deployed world.
    await section.locator('input[data-provider="null"]').check();
    await expect(section.locator('input[data-provider="null"]')).toBeChecked();
    const s = await operator.world.get<Session>("/api/_session");
    expect(s.provider.reason).toBe("default");
    await expect(current).toContainText(`New runs use ${providerLabel(s.provider.id)}.`);
    await section.locator('input[data-provider="scripted"]').check();
    await expect(section.locator('input[data-provider="scripted"]')).toBeChecked();
    await expect(current).toContainText("New runs use Scripted, no model calls.");
    expect((await operator.world.get<Session>("/api/_session")).provider).toEqual({ id: "scripted", reason: "world" });
  } finally {
    await pinProvider(operator.world);
  }
});

test("the Platform page reads today's caps, shares and Lobby state", async ({ page, operator }) => {
  void operator;
  await page.goto("/app/platform/");
  const readout = page.getByTestId("platform-readout");
  await expect(readout).toBeVisible();
  expect(await readout.getAttribute("data-day")).toBe(new Date().toISOString().slice(0, 10));
  await expect(page.getByTestId("platform-dollars")).toContainText("of $2.00");
  await expect(page.getByTestId("platform-leases")).toContainText("of 2");
  await expect(page.getByTestId("platform-shares")).toBeVisible();
  await expect(page.getByTestId("platform-level")).toContainText(/Level \d/);
});

// Known failure, recorded as contract request cf7 item 1 (.scratch/contract-requests/cf7.md): the app's own "Reset
// workspace data" ends the visitor's session in the browser. The reset answer reissues __Host-weft with the new generation, but a
// GET /api/_session already in flight carries the old one; the front then finds no lease for that generation and
// answers with both cookies cleared (Max-Age=0), which deletes the new cookie too. The Lobby still holds the lease. Seen
// every time in Chrome on the local stack (with the operator lease's cookies and with a browser-set lease alike).
test("the app's Reset workspace data keeps the visitor's own workspace", async ({ page, operator }) => {
  // The rows the operator lease's generation read and wrote so far (the shell checks above), against its budget.
  console.log(`shell rows budget: ${budgetLine((await operator.world.get<{ budget?: BudgetReadout }>("/api/v1/health")).budget ?? null)}`);
  await mutationHeadroom(4);
  await page.goto("/app/");
  expect(await bannerWorld(page)).toBe("slot");
  await page.getByTestId("viewing-as").click();
  await page.getByRole("menuitem", { name: /Reset workspace data/ }).click();
  await expect(page.locator("[data-tour-reset-note]")).toContainText("rebuilds your own workspace");
  const reset = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/sim/reset" && r.request().method() === "POST", { timeout: 120_000 });
  await page.locator("[data-tour-reset-go]").click();
  expect((await reset).status()).toBe(200);
  await page.waitForTimeout(5_000);
  await expect(page.getByTestId("hosted-ended")).toHaveCount(0);
  expect(await bannerWorld(page)).toBe("slot");
  expect((await operator.context.cookies()).map((c) => c.name).sort()).toEqual(["__Host-weft", "__Host-weft-h"]);
  await pinProvider(operator.world);
});
