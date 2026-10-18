// The rich profile crawl: every audited screen shows data. Run with `pnpm e2e:rich` (playwright.rich.config.ts),
// never under `pnpm e2e`, which uses the base seed where many of these screens are empty by design.
//
// For each route the test opens the page, clicks through every tab, and fails if an empty-state line the rich profile
// should fill is visible, or a line it must show is missing. KNOWN_GAPS lists the empty lines still left by design or
// for a later round; a gap that starts passing fails too, so the list only shrinks.
import { expect, test, type Page } from "@playwright/test";

type Check = { path: string; empty?: (string | RegExp)[]; need?: (string | RegExp)[] };
const zero = (label: string) => new RegExp(`(^|[^0-9,.])0 ${label}`);

const ROUTES: Check[] = [
  { path: "/", empty: [zero("agent runs logged")] },
  { path: "/app", empty: [zero("waiting"), zero("out today"), zero("onboarding"), "No upcoming payrolls."] },
  { path: "/app/inbox", empty: ["Nothing waiting for a decision.", "No suggestions right now.", "No decisions yet.", "No open hand-offs."] },
  { path: "/app/payroll", need: ["Jan 1 to Jan 15", "Oct 16 to Oct 31", "Imported"] },
  { path: "/app/people/wrk_0001", empty: ["No documents here.", "No history yet.", "No onboarding tasks."] },
  { path: "/app/people/wrk_0022", empty: ["No onboarding tasks.", "No documents here."] },
  { path: "/app/people/wrk_0049", empty: ["No accounts yet.", "No documents here.", "No onboarding tasks.", "Paychecks are blocked"] },
  { path: "/app/hiring", empty: ["No mail yet."] },
  { path: "/app/offboarding", empty: ["No offboarding cases yet."] },
  { path: "/app/offboarding/ofb_0002", need: ["Pell"] },
  { path: "/app/expenses", empty: ["Nothing here."] },
  { path: "/app/time-off", need: ["Taken"] },
  { path: "/app/contractors", empty: ["No payouts yet."] },
  { path: "/app/compliance", empty: ["No open hand-offs."] },
  { path: "/app/routines", need: [/Last run done/] },
  { path: "/app/routines/rt_people_digest", empty: ["No runs yet."] },
  { path: "/app/routines/rt_pre_payroll", empty: ["No runs yet."] },
  { path: "/app/reports", empty: ["Zero in this range, so not drawn"] },
  { path: "/app/audit", need: ["offers.create", /Chain valid through #\d{3}/] },
  { path: "/app/memory", empty: ["No file links here yet."] },
  { path: "/app/integrations", empty: ["No hires imported yet.", "Nothing to decide."] },
  { path: "/app/simulators", empty: ["No registrations.", "No mail from agencies yet.", "No device orders."] },
  { path: "/app/settings", empty: ["come next"], need: ["Permissions"] },
  { path: "/app/runs/run_9999", need: ["No run run_9999."] },
];

/** Empty lines that stay for now (none). Workday stays unsynced on purpose, so its "Nothing imported yet." is not checked:
 * a sync hands People, Compensation and Time off to Workday. October reconciliation stays un-run for the tour. */
const KNOWN_GAPS = new Set<string>([]);

async function settled(page: Page): Promise<string> {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  for (let i = 0; i < 20; i++) {
    const busy = await page.locator("text=/^Loading/").count().catch(() => 0);
    if (!busy) break;
    await page.waitForTimeout(250);
  }
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}
const has = (text: string, p: string | RegExp) => (typeof p === "string" ? text.includes(p) : p.test(text));

test("the rich profile fills every audited screen", async ({ page, request }) => {
  const stats = await (await request.get("/api/v1/stats")).json() as { runsLogged?: number; actionsLogged?: number };
  expect(stats.runsLogged ?? 0, "agent runs logged").toBeGreaterThanOrEqual(20);
  expect(stats.actionsLogged ?? 0, "actions logged").toBeGreaterThanOrEqual(100);
  const runs = await (await request.get("/api/v1/agent/runs?limit=1", { headers: { "x-weft-principal": "usr_dana" } })).json() as { data?: { id: string }[] };
  const runId = runs.data?.[0]?.id;
  expect(runId, "a recorded agent run").toBeTruthy();
  const routes: Check[] = [...ROUTES, { path: `/app/runs/${runId}`, need: ["Steps", "Scripted, no model"] }];

  const failures: string[] = [];
  const gapsSeen = new Set<string>();
  for (const r of routes) {
    await page.goto(r.path);
    await expect(page.locator("body")).not.toContainText("Application error");
    const texts = [await settled(page)];
    // Top-level tabs only: a filter tab inside a panel (Sent, Pending) may be empty by design.
    const tabs = page.locator("[role=tab]:not([role=tabpanel] [role=tab])");
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      await tabs.nth(i).click().catch(() => {});
      texts.push(await settled(page));
    }
    const all = texts.join(" | ");
    for (const e of r.empty ?? []) {
      if (!has(all, e)) continue;
      const key = `${r.path} ${String(e)}`;
      if (KNOWN_GAPS.has(key)) { gapsSeen.add(key); continue; }
      failures.push(`${r.path}: shows ${String(e)}`);
    }
    for (const n of r.need ?? []) if (!has(all, n)) failures.push(`${r.path}: missing ${String(n)}`);
  }
  for (const g of KNOWN_GAPS) if (!gapsSeen.has(g)) failures.push(`known gap is filled now, drop it from KNOWN_GAPS: ${g}`);
  expect(failures, failures.join("\n")).toEqual([]);
});

test("the rich profile's history adds up in Reports, and the audit table fits", async ({ page, request }) => {
  const h = { "x-weft-principal": "usr_dana" };
  const moves = await (await request.get("/api/v1/reports/hires_and_departures_by_month?from=2026-01-01&to=2026-10-31", { headers: h })).json() as { rows: { hires: number; departures: number }[] };
  expect(moves.rows.filter((r) => r.hires > 0).length, "months with hires").toBeGreaterThanOrEqual(4);
  expect(moves.rows.filter((r) => r.departures > 0).length, "months with departures").toBeGreaterThanOrEqual(3);
  const cost = await (await request.get("/api/v1/reports/payroll_cost_by_month?from=2026-01-01&to=2026-10-31", { headers: h })).json() as { rows: { reimbursements_cents: number; contractor_cents: number }[] };
  expect(cost.rows.length, "months with paid runs").toBeGreaterThanOrEqual(10);
  expect(cost.rows.filter((r) => r.reimbursements_cents > 0).length, "months with reimbursements").toBeGreaterThanOrEqual(4);
  expect(cost.rows.filter((r) => r.contractor_cents > 0).length, "months with contractor payouts").toBeGreaterThanOrEqual(6);
  await page.goto("/app/audit");
  await expect(page.getByText(/Chain valid through #\d{3}/)).toBeVisible();
  const overflow = await page.locator("table").first().evaluate((t) => { const box = t.parentElement!; return box.scrollWidth - box.clientWidth; });
  expect(overflow, "audit table scrolls sideways at 1440 px").toBeLessThanOrEqual(1);
});

test("a manager's Home shows the team, and each portal persona sees its own record", async ({ page, request }) => {
  await page.addInitScript(() => { try { window.localStorage.setItem("weft.viewingAs", "usr_imani"); } catch { /* storage blocked */ } });
  await page.goto("/app");
  const team = page.getByTestId("home-widget-team");
  await expect(team).toBeVisible();
  await expect(page.getByTestId("home-team-decisions")).toBeVisible();
  await expect(team).toContainText("Joining");

  const offers = await (await request.get("/api/v1/offers?limit=100", { headers: { "x-weft-principal": "usr_dana" } })).json() as { data?: { candidateFirst: string; status: string; personaPrincipalId: string | null }[] };
  expect((offers.data ?? []).filter((o) => o.status === "accepted").length, "accepted offers").toBeGreaterThanOrEqual(3);
  const odette = (offers.data ?? []).find((o) => o.candidateFirst === "Odette" && o.personaPrincipalId);
  expect(odette, "a payroll-ready new hire with a portal persona").toBeTruthy();
  await page.goto(`/portal?as=${odette!.personaPrincipalId}`);
  await expect(page.getByTestId("portal-time-off")).toBeVisible();
  await expect(page.getByTestId("portal-training")).toContainText("New York");
  await expect(page.getByTestId("portal-training")).not.toContainText("California harassment prevention for supervisors");
  await expect(page.locator("body")).not.toContainText("No expenses yet.");
});
