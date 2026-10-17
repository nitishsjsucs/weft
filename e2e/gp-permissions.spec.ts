// Permissions (wave 4, w4-parity-admin). At 1440 with the agent docked: the matrix shows each person's View, Edit or
// Approve level per domain with what the agent may do for them (never Approve), and the agent's own row; an override
// is filed as a proposal and appears only after approval. At 390 the matrix scrolls inside its card, not the page.
import type { Page } from "@playwright/test";
import { expect, openApp, test, WeftApi } from "./fixtures";
import { W3_SHELL_TID as S } from "../packages/contracts/src/w3/testids-shell";
import { W4_ADMIN_TID as T } from "../apps/web/src/components/app/reports/testids";
import { W4_GALLERY_TID as G } from "../apps/web/src/components/app/routines/gallery/testids";

type Prop = { id: string; status: string; command: string };

async function noSideScroll(page: Page, label: string) {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, `${label}: page scrollWidth ${m.scroll} within ${m.client}`).toBeLessThanOrEqual(m.client);
}

test("Permissions: the matrix per person and for the agent, and an override set by proposal", async ({ page, request }) => {
  const weft = new WeftApi(request);
  await test.step("1440 docked: levels per domain with the agent's level under each", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/app/settings/permissions");
    await expect(page.getByTestId(S.agentToggle)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(T.matrix)).toBeVisible();
    for (const id of ["usr_dana", "usr_theo", "usr_sam", "agt_weft"]) await expect(page.getByTestId(T.matrixRow(id))).toBeVisible();
    const theoPayroll = page.getByTestId(T.matrixCell("usr_theo", "payroll"));
    await expect(theoPayroll).toHaveAttribute("data-level", "approve");
    await expect(theoPayroll).toHaveAttribute("data-agent-level", "edit");
    await expect(page.getByTestId(T.matrixCell("usr_theo", "benefits"))).toHaveAttribute("data-agent-level", "none");
    await expect(page.getByTestId(T.matrixCell("agt_weft", "payroll"))).toHaveAttribute("data-level", "edit");
    await noSideScroll(page, "1440");
  });

  await test.step("an override is a proposal; the matrix changes once it is approved", async () => {
    await page.getByTestId(T.overridePrincipal).selectOption("usr_sam");
    await page.getByTestId(T.overrideCommand).fill("comms.send_message");
    await page.getByTestId(T.overrideMode).selectOption("propose_only");
    await page.getByTestId(T.overrideSubmit).click();
    await expect(page.getByTestId(T.overrideResult)).toHaveAttribute("data-status", "pending_approval");
    await expect(page.getByTestId(T.overrideList("usr_sam"))).toHaveAttribute("data-count", "0");
    const pending = await weft.get<{ data: Prop[] }>("/v1/proposals", { status: "pending", limit: 100 });
    const p = pending.data.find((x) => x.command === "settings.set_agent_action_override")!;
    expect(p).toBeTruthy();
    await weft.post(`/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null });
    await page.reload();
    await expect(page.getByTestId(T.overrideList("usr_sam"))).toHaveAttribute("data-count", "1");
    await expect(page.getByTestId(T.overrideList("usr_sam"))).toContainText("comms.send_message");
  });

  await test.step("390: the matrix scrolls inside its card and the page does not", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/app/settings/permissions");
    await expect(page.getByTestId(T.matrix)).toBeVisible();
    await expect(page.getByTestId(T.overrideSubmit)).toBeVisible();
    await noSideScroll(page, "390");
  });
});

// Routine gallery (G10, G7, G8), here because this track owns two spec files: created by, enabled at, last and next
// run and decision counts per routine on the Routines page, the same numbers beside the autonomy control on a
// routine's page, and cards with no sideways scroll at 390.
type GalleryRow = { routineId: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; approvals: number; overrides: number; schedule: string };

test("Routine gallery: last and next run and decision counts per routine", async ({ page, request }) => {
  const weft = new WeftApi(request);
  const rows = await weft.get<GalleryRow[]>("/v1/routine-gallery");
  const pre = rows.find((r) => r.routineId === "rt_pre_payroll")!;
  expect(pre.enabled && pre.nextRunAt).toBeTruthy();
  const off = rows.find((r) => !r.enabled && r.schedule.startsWith("cron"))!;
  expect(off.nextRunAt).toBeNull();
  await test.step("1440 docked: one row per routine with the API's next run", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "/app/routines");
    await expect(page.getByTestId(S.agentToggle)).toHaveAttribute("aria-pressed", "true");
    const row = page.getByTestId(G.row("rt_pre_payroll"));
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-next-run", pre.nextRunAt!);
    await expect(page.getByTestId(G.row(off.routineId))).toHaveAttribute("data-next-run", "");
    await expect(page.getByTestId(G.row(off.routineId))).toContainText("Off while disabled");
    await expect(page.locator(`[data-testid^="routine-gallery-row-"]`)).toHaveCount(rows.length);
    await noSideScroll(page, "gallery 1440");
  });
  await test.step("the routine page shows its history beside the autonomy control", async () => {
    await openApp(page, "/app/routines/rt_pre_payroll");
    const counts = page.getByTestId(G.counts("rt_pre_payroll"));
    await expect(counts).toBeVisible();
    await expect(counts.locator('[data-count="approvals"]')).toHaveText(String(pre.approvals));
    await expect(counts.locator('[data-count="overrides"]')).toHaveText(String(pre.overrides));
    await expect(counts).toContainText("Prebuilt");
  });
  await test.step("390: cards, no sideways page scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/app/routines");
    await expect(page.getByTestId(G.card("rt_pre_payroll"))).toBeVisible();
    await noSideScroll(page, "gallery 390");
  });
});
