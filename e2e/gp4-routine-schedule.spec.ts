// GP4. A routine runs on schedule and logs its run (SPEC 12, P0-8). Owner of the spec: t6-site.
// "+30 min" from Monday 08:30 PT fires the weekly people digest at 09:00 (unattended, zero tokens); the run log
// shows it done with no approvals and #people-ops has the digest; advancing again creates no duplicate; then the
// create-your-own box drafts a disabled Friday routine and a routine_enable proposal through the deterministic parser.
import { byTidPrefix, chatChannel, eventually, expect, openApp, SEED, SIM_STEP, test, TID, tid } from "./fixtures";

const DRAFT_PROMPT = "Every Friday, post open approvals to #payroll";

test("GP4: the weekly digest fires at 09:00 once, and a custom routine is drafted disabled", async ({ page, weft }) => {
  const runsBefore = (await weft.routineRuns(SEED.digestRoutine)).length;
  const chatBefore = (await weft.chat("#people-ops")).length;

  await test.step("+30 min fires the digest at 09:00 PT", async () => {
    await openApp(page, "/app/simulators");
    await page.getByTestId(tid.simAdvance(SIM_STEP.thirtyMinutes)).click();
    await expect(page.getByTestId(TID.simClock)).toContainText(/9:00/);
    const run = await eventually(() => weft.routineRuns(SEED.digestRoutine), (rs) => (rs.length > runsBefore ? rs.find((r) => r.status === "done") : null), "a done digest run");
    expect(run.triggerRef).toMatch(/cron/);
    expect(run.triggerRef).toContain("2026-10-26T09:00");
    expect(run.attended).toBe(false);
    expect(run.leftForHuman).toEqual([]);
    expect((await weft.proposals("pending")).filter((p) => p.routineRunId === run.id)).toHaveLength(0);
  });

  await test.step("the run log and #people-ops show it", async () => {
    await openApp(page, `/app/routines/${SEED.digestRoutine}`);
    const rows = page.getByTestId(TID.routineRunRow);
    await expect(rows).toHaveCount(runsBefore + 1);
    await expect(rows.first()).toContainText(/done/i);
    await expect(rows.first()).toContainText(/cron/i);
    const chat = await eventually(() => weft.chat("#people-ops"), (ms) => (ms.length > chatBefore ? ms : null), "a digest in #people-ops");
    expect(chat.length).toBe(chatBefore + 1);
    await openApp(page, "/app/simulators");
    await expect(chatChannel(page, "#people-ops")).toContainText(chat[chat.length - 1]!.text.slice(0, 40));
  });

  await test.step("advancing again in the same slot creates no duplicate (run key)", async () => {
    await page.getByTestId(tid.simAdvance(SIM_STEP.thirtyMinutes)).click();
    await expect(page.getByTestId(TID.simClock)).toContainText(/9:30/);
    await weft.advanceClock({ by: "PT1M" });
    const runs = await weft.routineRuns(SEED.digestRoutine);
    expect(runs.filter((r) => r.status !== "skipped")).toHaveLength(runsBefore + 1);
    expect((await weft.chat("#people-ops")).length).toBe(chatBefore + 1);
  });

  await test.step("create-your-own drafts a disabled Friday routine and a routine_enable proposal", async () => {
    const before = new Set((await weft.routines()).map((r) => r.id));
    await openApp(page, "/app/routines");
    await page.getByTestId(TID.routineDraftInput).fill(DRAFT_PROMPT);
    await page.getByTestId(TID.routineDraftSubmit).click();
    const drafted = await eventually(() => weft.routines(), (rs) => rs.find((r) => !before.has(r.id)), "a new routine");
    expect(drafted.enabled).toBe(false);
    expect(drafted.source).toBe("custom");
    expect(drafted.trigger).toEqual({ type: "cron", cron: "0 9 * * 5", tz: "America/Los_Angeles" });
    expect(drafted.tools).toEqual(["comms.send_message"]);
    await expect(page.getByTestId(tid.routineCard(drafted.id))).toBeVisible();

    const enable = await eventually(() => weft.proposals("pending"), (ps) => ps.find((p) => p.kind === "routine_enable"), "a routine_enable proposal");
    await openApp(page, "/app/inbox");
    await expect(page.getByTestId(tid.inboxCard(enable.id))).toBeVisible();
    await expect(byTidPrefix(page, "inbox-card-")).toHaveCount((await weft.proposals("pending")).length);
  });
});
