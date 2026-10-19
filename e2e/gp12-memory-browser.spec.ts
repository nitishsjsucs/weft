// GP12 in the browser (docs/wave2.md, harness 18). Owner: the wave 2 integrator, from the w2-memory left list.
// The memory digest (a deterministic routine, no model) coarsens the seeded week and writes the dossiers and the
// company one-pager; the read-only /app/memory browser, reached from the Memory nav entry, opens the one-pager,
// follows a person's dossier with its backlinks, and expands a history entry to its diff.
import { eventually, expect, openApp, test } from "./fixtures";

interface RoutineRunDto { id: string; status: string; summary: string | null }

test("GP12: the memory digest's dossiers and one-pager show in the memory browser with backlinks and history", async ({ page, weft }) => {
  await test.step("the digest runs as a deterministic step and commits", async () => {
    await weft.post("/v1/routines/rt_memory_digest/trigger", {});
    const run = await eventually(() => weft.routineRuns("rt_memory_digest"), (rs) => (rs as unknown as RoutineRunDto[]).find((r) => /^Memory digest committed/.test(r.summary ?? "")), "a committed digest");
    expect(run.status).toBe("skipped");
  });

  await test.step("the Memory nav entry opens the browser on the company one-pager", async () => {
    await openApp(page, "/app");
    await page.locator('a[href="/app/memory"]').first().click();
    await expect(page).toHaveURL(/\/app\/memory/);
    await expect(page.getByTestId("memory-tree")).toBeVisible();
    const file = page.getByTestId("memory-file");
    await expect(file).toHaveAttribute("data-path", "knowledge/company/one-pager.md");
    await expect(file).toContainText("Headcount by state");
  });

  await test.step("a person's dossier shows dated, sourced facts and its backlinks", async () => {
    await page.goto("/app/memory#entities%2Fpeople%2Fwrk_0026.md");
    const file = page.getByTestId("memory-file");
    await expect(file).toHaveAttribute("data-path", "entities/people/wrk_0026.md");
    // Each fact reads its date and source as words; the stored provenance stays on the line (title, data-source).
    await expect(file).toContainText(/as of \w{3} \d{1,2}, from the person record/);
    await expect(file.locator('[data-source="worker:wrk_0026"]').first()).toBeVisible();
    await expect(page.getByTestId("memory-backlinks")).toContainText("timeline/daily/2026-10-09");
  });

  await test.step("the history entry expands to the digest commit's diff", async () => {
    const entry = page.getByTestId("memory-history-entry").first();
    await expect(entry).toContainText("memory digest");
    await entry.click();
    await expect(entry).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("memory-history").locator("pre")).toContainText("+");
  });
});
