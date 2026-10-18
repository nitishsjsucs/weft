// The rich profile crawl: every audited screen shows data. Run with `pnpm e2e:rich` (playwright.rich.config.ts),
// never under `pnpm e2e`, which uses the base seed where these screens are empty by design.
//
// For each route the test opens the page, clicks through every tab, and fails if an empty-state line the rich profile
// should fill is visible. KNOWN_GAPS lists the lines round 2 still has to fill; a gap that starts passing fails too,
// so the list only shrinks.
import { expect, test, type Page } from "@playwright/test";

const ROUTES: { path: string; empty: string[] }[] = [
  { path: "/app", empty: ["0 waiting"] },
  { path: "/app/inbox", empty: ["Nothing waiting for a decision.", "No suggestions right now.", "No decisions yet.", "No open hand-offs."] },
  { path: "/app/offboarding", empty: ["No offboarding cases yet."] },
  { path: "/app/routines", empty: [] },
  { path: "/app/routines/rt_people_digest", empty: ["No runs yet."] },
  { path: "/app/routines/rt_pre_payroll", empty: ["No runs yet."] },
  { path: "/app/contractors", empty: ["No payouts yet."] },
  { path: "/app/people/wrk_0022", empty: ["No onboarding tasks.", "No documents here."] },
  { path: "/app/people/wrk_0001", empty: ["No documents here.", "No history yet."] },
  { path: "/app/time-off", empty: [] },
  { path: "/app/compliance", empty: ["No open hand-offs."] },
  { path: "/app/audit", empty: [] },
  { path: "/app/memory", empty: [] },
  { path: "/app/simulators", empty: ["No registrations.", "No mail from agencies yet."] },
  { path: "/app/expenses", empty: [] },
  { path: "/app/benefits", empty: [] },
  { path: "/app/hiring", empty: [] },
  { path: "/app/integrations", empty: [] },
  { path: "/app/reports", empty: [] },
];

/** Empty lines round 2 fills (offers, expenses paid out, device orders, reconciliation history, integrations). */
const KNOWN_GAPS = new Set<string>([]);

async function visibleTexts(page: Page): Promise<string> {
  await page.waitForLoadState("networkidle").catch(() => {});
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

test("the rich profile fills every audited screen", async ({ page, request }) => {
  const stats = await (await request.get("/api/v1/stats")).json() as { runsLogged?: number; actionsLogged?: number };
  expect(stats.runsLogged ?? 0, "agent runs logged").toBeGreaterThanOrEqual(20);
  expect(stats.actionsLogged ?? 0, "actions logged").toBeGreaterThanOrEqual(100);
  const failures: string[] = [];
  const gapsSeen = new Set<string>();
  for (const r of ROUTES) {
    await page.goto(r.path);
    await expect(page.locator("body")).not.toContainText("Application error");
    const texts = [await visibleTexts(page)];
    const tabs = page.locator("[role=tab]");
    for (let i = 0; i < (await tabs.count()); i++) {
      await tabs.nth(i).click().catch(() => {});
      texts.push(await visibleTexts(page));
    }
    const all = texts.join(" | ");
    if (/Last run never/.test(all) && r.path === "/app/routines" && !/Last run (?!never)/.test(all)) failures.push(`${r.path}: every routine says Last run never`);
    for (const e of r.empty) {
      if (!all.includes(e)) continue;
      if (KNOWN_GAPS.has(`${r.path} ${e}`)) { gapsSeen.add(`${r.path} ${e}`); continue; }
      failures.push(`${r.path}: "${e}"`);
    }
  }
  for (const g of KNOWN_GAPS) if (!gapsSeen.has(g)) failures.push(`known gap is filled now, drop it from KNOWN_GAPS: ${g}`);
  expect(failures, failures.join("\n")).toEqual([]);
});
