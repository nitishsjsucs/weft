// The guided tour on the hosted stack (design 11.5 and 11.6), track cf7-integrate: autoplay on the operator lease's pool
// slot, timed from the first card to the end, under 180 s, with every step's card on its own target. Before the tour the
// world is reset with the hosted reset, which the front Worker sends through the Lobby (a new generation in the cookie,
// one reset fewer on the lease); then the scripted provider is pinned again, since the reset rebuilt the world's
// settings (WEFT_CF_LIVE=1 keeps the demo default: one live tour).
// The measured time is printed, attached, and written to WEFT_CF_TOUR_OUT when set (scripts/cf/smoke.ts reads it).
import { writeFileSync } from "node:fs";
import { TOUR_STEPS } from "../../apps/web/src/components/tour/steps";
import { expect, LIVE, pinProvider, test } from "./fixtures";
import { budgetLine, mutationHeadroom, recentRuns, runsSince, type BudgetReadout } from "./world";
import { allPages } from "./scenarios";

const SEED_NOW = "2026-10-26T15:30:00.000Z";

test("the guided tour autoplays on a leased hosted world within 180 s, every step on its own target", async ({ page, operator, consoleErrors }, info) => {
  test.setTimeout(330_000);
  const w = operator.world;

  // The hosted reset: POST /api/v1/sim/reset, which the front Worker sends through the Lobby (a new generation in the
  // reissued cookie, one reset fewer on the lease). It is sent before the app is open: with the app open, a session
  // read in flight with the old generation clears the new cookie (contract request cf7 item 1; cf-shell.spec.ts has
  // the in-app case).
  await mutationHeadroom(4);
  const r = await w.post<{ ok: boolean; gen: number; resetsLeft: number; profile: string }>("/api/v1/sim/reset", {}, { timeoutMs: 120_000 });
  expect(r.profile).toBe("rich");
  expect(r.gen, "the Lobby gave the world a new generation").toBeGreaterThan(operator.lease.gen);
  expect(r.resetsLeft).toBe(operator.lease.resetsLeft - 1);
  await pinProvider(w);
  const session = await w.get<{ lease: { gen: number } | null; provider: { id: string } }>("/api/_session");
  expect(session.lease?.gen, "the cookie was reissued with the new generation").toBe(r.gen);
  const clock = await w.get<{ now: string; rate: number }>("/api/v1/sim/clock");
  expect(clock).toMatchObject({ now: SEED_NOW, rate: 0 });

  // The tour's own mutations (deliver, approve, the chart question, the portal) need RL_MUTATE headroom.
  await mutationHeadroom(15);
  const executedBefore = new Set((await allPages<{ id: string }>(w, "/api/v1/proposals?status=executed")).map((p) => p.id));
  const runsBefore = await recentRuns(w);
  const errorsBefore = consoleErrors.length;

  await page.goto("/app/?tour=1&autoplay=1");
  const welcome = page.locator('[data-tour-card][data-ready="true"][data-step="welcome"]');
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(0, 0);
  const t0 = Date.now();
  const seen: string[] = [];
  const at: Record<string, number> = {};
  const match: Record<string, string | null> = {};
  const notes: Record<string, string[]> = {};
  const poll = setInterval(() => {
    void page.locator("[data-tour-card][data-ready=\"true\"]").evaluate((el) => ({
      step: el.getAttribute("data-step"),
      found: el.getAttribute("data-target-found"),
      match: el.getAttribute("data-target-match"),
      lines: [...el.querySelectorAll("[data-tour-note]")].map((n) => (n.textContent ?? "").trim()),
    }), undefined, { timeout: 200 }).then((s) => {
      if (!s.step) return;
      if (seen[seen.length - 1] !== s.step) { seen.push(s.step); at[s.step] = Date.now() - t0; }
      if (s.found === "true") match[s.step] = s.match;
      else match[s.step] ??= null;
      for (const l of s.lines) if (!(notes[s.step] ??= []).includes(l)) notes[s.step]!.push(l);
    }, () => undefined);
  }, 250);
  try {
    await expect(page.locator("[data-tour-card]")).toHaveCount(0, { timeout: 200_000 });
  } finally { clearInterval(poll); }
  const total = Date.now() - t0;

  // The rows this generation (the reset above, then the tour) read and wrote, against its budget (design 6.3).
  const budget = (await w.get<{ budget?: BudgetReadout }>("/api/v1/health")).budget ?? null;
  const out = { total, steps: seen.length, seen, at, match, notes, live: LIVE, slot: operator.lease.slot, budget };
  console.log(`hosted tour ${(total / 1000).toFixed(1)} s over ${seen.length} steps on ${operator.lease.slot}${LIVE ? " (live)" : " (scripted)"}; step starts (ms) ${JSON.stringify(at)}`);
  console.log(`hosted tour rows budget: ${budgetLine(budget)}; ${(await runsSince(w, runsBefore)).line}`);
  await info.attach("cf-tour.json", { body: JSON.stringify(out, null, 2), contentType: "application/json" });
  if (process.env.WEFT_CF_TOUR_OUT) writeFileSync(process.env.WEFT_CF_TOUR_OUT, JSON.stringify(out, null, 2));

  expect(total, "the whole tour within 180 s").toBeLessThanOrEqual(180_000);
  expect(seen, "every step shows, in order").toEqual(TOUR_STEPS.map((s) => s.id));
  const offTarget = TOUR_STEPS.filter((s) => s.target && match[s.id] !== "primary").map((s) => `${s.id}: ${match[s.id] ?? "not found"}`);
  expect(offTarget, "every step on its own target").toEqual([]);
  expect(notes, "no step fell back to a note").toEqual({});

  await expect(page.getByTestId("hosted-banner"), "the tab still reads its own slot after the tour").toHaveAttribute("data-world", "slot");
  const executed = (await allPages<{ id: string; command: string }>(w, "/api/v1/proposals?status=executed")).filter((p) => !executedBefore.has(p.id));
  expect(executed.map((p) => p.command), "the tour executes exactly one proposal, the rate change").toEqual(["tax.update_rate"]);
  expect((await w.get<{ ok: boolean }>("/api/v1/actions/verify")).ok, "the audit chain verifies").toBe(true);
  expect(consoleErrors.slice(errorsBefore), "no console errors during the tour").toEqual([]);
});
