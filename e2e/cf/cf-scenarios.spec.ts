// The eight demo scenarios (docs/demo-scenarios.md) with their key figures on the hosted stack (design 11.6), track
// cf7-integrate. They run through the hosted API of the operator lease's pool slot, from the browser context's own
// request context (so the front Worker sees the session and grant cookies, Origin and the principal exactly as from the
// app), on a world reset through the Lobby first (the hosted reset), with the scripted provider pinned. The Inbox card
// of scenario 1 is also read in the browser. The scenario logic is shared with the smoke (e2e/cf/scenarios.ts).
import { expect, test } from "@playwright/test";
import { operatorLease, OPERATOR, pinProvider, PwWorld, targetFor, type LeaseInfo } from "./fixtures";
import { resetWorld, SCENARIOS, type ScenarioContext } from "./scenarios";
import { budgetLine, recentRuns, runsSince, type BudgetReadout } from "./world";
import type { BrowserContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let world: PwWorld;
let lease: LeaseInfo;
/** The runs the world had before the scenarios (the seed's), so the scenarios' own runs can be counted. */
let seedRuns: { id: string }[] = [];

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(180_000);
  const target = targetFor(info.project.use.baseURL);
  context = await browser.newContext({ baseURL: target.origin });
  lease = await operatorLease(context.request, target.origin, target.sign);
  world = new PwWorld(context.request, target.origin, target.sign, `${lease.slot} (operator lease ${OPERATOR})`, OPERATOR);
  const before = lease.gen;
  const r = await resetWorld(world);
  expect(r.gen, "the hosted reset bumps the world's generation").toBeGreaterThan(before);
  // The reset rebuilt the world from the snapshot, model setting included: pin the scripted provider again.
  await pinProvider(world);
  const s = await world.get<{ world: string; lease: { slot: string; gen: number } | null }>("/api/_session");
  expect(s.world).toBe("slot");
  expect(s.lease?.gen, "the cookie carries the new generation").toBe(r.gen);
  seedRuns = await recentRuns(world);
  console.log(`scenarios on ${world.label}: reset to gen ${r.gen} (${r.method ?? "reset"}), ${r.resetsLeft ?? "?"} resets left`);
});

test.afterAll(async () => { await context?.close(); });

const ctx = (): ScenarioContext => ({
  world, mcpWorld: world,
  mintMcpKey: () => world.post<{ key: string; url: string }>("/api/_hosted/mcp-key", {}),
});

for (const s of SCENARIOS) {
  test(`scenario ${s.id}: ${s.title}`, async ({}, info) => {
    test.setTimeout(240_000);
    if (s.id === "1") {
      // The browser shows the same figures on the Inbox card before the approval.
      const page = await context.newPage();
      await page.goto("/app/inbox/");
      const card = page.locator('[data-tour~="inbox-card"]').filter({ hasText: "Update CA SUI rate 3.4% to 1.5%" }).first();
      await expect(card).toBeVisible({ timeout: 45_000 });
      await expect(card).toContainText("$5,489.93");
      await expect(card).toContainText("$2,422.04");
      await page.close();
    }
    const t0 = Date.now();
    const evidence = await s.run(ctx());
    info.annotations.push({ type: "figures", description: evidence });
    console.log(`scenario ${s.id} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${evidence}`);
  });
}

test("after the scenarios the audit chain verifies", async ({}, info) => {
  expect((await world.get<{ ok: boolean }>("/api/v1/actions/verify")).ok).toBe(true);
  // The rows this generation (the reset, then all eight scenarios) read and wrote, against its budget (design 6.3).
  const budget = (await world.get<{ budget?: BudgetReadout }>("/api/v1/health")).budget ?? null;
  const runs = await runsSince(world, seedRuns);
  console.log(`scenarios rows budget: ${budgetLine(budget)}; ${runs.line}`);
  info.annotations.push({ type: "rows budget", description: `${budgetLine(budget)}; ${runs.line}` });
  expect(budget, "a leased world reports its rows budget").not.toBeNull();
});
