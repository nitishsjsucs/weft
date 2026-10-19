// Rich-profile screenshots for docs/screenshots/ (README Screenshots). `pnpm screenshots:rich` runs it through
// playwright.screens-rich.config.ts: a fresh rich world (scripted provider, frozen clock) on its own ports and data
// dir, every main route at 1440 by 900 as Dana with the agent panel docked. Plain route views keep their existing
// names (02-app-home, 08-people and so on); routes the base capture never showed get new ones (26 onward). The flow
// shots (04-agent-run, 05-inbox, 13-hiring and the rest) stay with `pnpm screenshots` on the base world.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApp, viewAs } from "../fixtures";

const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/screenshots", import.meta.url));
const DANA = { "x-weft-principal": "usr_dana" };

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (!(await page.locator("text=/^Loading/").count().catch(() => 0))) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
}

const shot = async (page: Page, name: string, fullPage = false) => {
  await settled(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1, page.viewportSize()!.height - 1);
  await expect(page.locator("body")).not.toContainText("Application error");
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api${path}`, { headers: DANA });
  expect(r.ok(), `${path} -> ${r.status()}`).toBe(true);
  return (await r.json()) as T;
}

/** Plain route views: [file name, path]. */
const ROUTES: [string, string][] = [
  ["02-app-home", "/app"],
  ["26-inbox", "/app/inbox"],
  ["06-payroll", "/app/payroll"],
  ["08-people", "/app/people"],
  ["27-person", "/app/people/wrk_0001"],
  ["28-hiring-offers", "/app/hiring"],
  ["29-offboarding", "/app/offboarding"],
  ["30-benefits", "/app/benefits"],
  ["31-it", "/app/it"],
  ["32-contractors", "/app/contractors"],
  ["22-expenses", "/app/expenses"],
  ["33-time-off", "/app/time-off"],
  ["11-compliance", "/app/compliance"],
  ["34-reports", "/app/reports"],
  ["09-routines", "/app/routines"],
  ["35-routine-detail", "/app/routines/rt_pre_payroll"],
  ["10-audit", "/app/audit"],
  ["17-memory", "/app/memory"],
  ["24-integrations", "/app/integrations"],
  ["03-simulators", "/app/simulators"],
  ["36-settings", "/app/settings"],
  ["37-permissions", "/app/settings/permissions"],
];

test("rich profile screens", async ({ page, request }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const health = await getJson<{ seedProfile?: string }>(request, "/v1/health");
  expect(health.seedProfile, "the capture runs on the rich world").toBe("rich");

  await page.goto("/");
  await shot(page, "01-landing");
  await shot(page, "01b-landing-full", true);

  await openApp(page, "/app");
  await viewAs(page, "dana");
  for (const [name, path] of ROUTES) {
    await openApp(page, path);
    await shot(page, name);
  }

  // A processed pay run imported from the previous provider, and the agent run view on a recorded run with steps.
  const runs = await getJson<{ data: { id: string; status: string; periodStart: string }[] }>(request, "/v1/payrolls?limit=100");
  const imported = runs.data.filter((r) => r.status !== "draft").sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))[0];
  expect(imported, "an imported pay run").toBeTruthy();
  await openApp(page, `/app/payroll/${imported!.id}`);
  await shot(page, "38-payroll-imported-run");
  const agentRuns = await getJson<{ data: { id: string }[] }>(request, "/v1/agent/runs?limit=1");
  expect(agentRuns.data[0], "a recorded agent run").toBeTruthy();
  await openApp(page, `/app/runs/${agentRuns.data[0]!.id}`);
  await shot(page, "39-run-view");

  // The new-hire portal as a rich persona (an accepted offer part way through the checklist).
  const offers = await getJson<{ data: { status: string; personaPrincipalId?: string | null }[] }>(request, "/v1/offers?limit=100");
  const persona = offers.data.find((o) => o.status === "accepted" && o.personaPrincipalId)?.personaPrincipalId;
  expect(persona, "a new-hire persona").toBeTruthy();
  await page.goto(`/portal?as=${encodeURIComponent(persona!)}`);
  await shot(page, "40-portal-persona");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await shot(page, "12-landing-mobile");
});
