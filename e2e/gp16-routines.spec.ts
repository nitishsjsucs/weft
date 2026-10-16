// GP16. Routine parity: the autonomy control and the agent settings (docs/wave3.md). Owner: w3-parity-routines.
// Settings > Agent shows both switches off; turning on auto autonomy is saved. On a routine, picking Recommend files a
// proposal (nothing changes yet); approving it in the Inbox moves the control to Recommend. An escalated notice shows
// the specialist hand-off in the Compliance drawer.
import { approveCard, eventually, expect, openApp, test, type Proposal } from "./fixtures";
import { W3_ROUTINES_TID as T } from "../packages/contracts/src/w3/testids-parity";

const ROUTINE = "rt_milestones";

test("GP16: agent settings and a routine autonomy change through the Inbox", async ({ page, weft }) => {
  await test.step("Settings > Agent: both switches start off, auto autonomy turns on", async () => {
    await openApp(page, "/app/settings");
    const card = page.getByTestId(T.settingsAgent);
    await expect(card).toBeVisible();
    await expect(page.getByTestId(T.settingChatCanPropose)).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId(T.settingAllowAutoAutonomy)).toHaveAttribute("aria-checked", "false");
    await page.getByTestId(T.settingAllowAutoAutonomy).click();
    await expect(page.getByTestId(T.settingAllowAutoAutonomy)).toHaveAttribute("aria-checked", "true");
    expect(await weft.get<{ chatCanPropose: boolean; allowAutoAutonomy: boolean }>("/v1/settings/agent")).toEqual({ chatCanPropose: false, allowAutoAutonomy: true });
  });

  let proposal: Proposal;
  await test.step("picking Recommend files a proposal and changes nothing yet", async () => {
    await openApp(page, `/app/routines/${ROUTINE}`);
    const control = page.getByTestId(T.autonomy(ROUTINE));
    await expect(control).toHaveAttribute("data-level", "approve");
    await expect(page.getByTestId(T.autonomyLevel(ROUTINE, "auto"))).toBeEnabled();
    await page.getByTestId(T.autonomyLevel(ROUTINE, "recommend")).click();
    await expect(page.getByTestId(T.autonomyStatus(ROUTINE))).toContainText(/waits for approval/i);
    proposal = await eventually(() => weft.proposals("pending"), (ps) => ps.find((p) => p.command === "routines.set_autonomy" && p.subjectRef === ROUTINE), "an autonomy proposal");
    expect(proposal.diff).toEqual([{ label: "autonomy", before: "approve", after: "recommend" }]);
    expect((await weft.routines()).find((r) => r.id === ROUTINE)?.autonomy).toBe("approve");
  });

  await test.step("the routines page shows the favorites gallery with Try it and run times", async () => {
    await openApp(page, "/app/routines");
    const gallery = page.getByTestId(T.gallery);
    await expect(gallery).toBeVisible();
    await expect(gallery.getByTestId(T.tryIt("rt_new_hire_ready"))).toBeVisible();
    await expect(gallery).toContainText(/Next run/);
  });

  await test.step("approving it in the Inbox moves the routine to Recommend", async () => {
    await openApp(page, "/app/inbox");
    await approveCard(page, weft, proposal.id);
    expect((await weft.routines()).find((r) => r.id === ROUTINE)?.autonomy).toBe("recommend");
    await openApp(page, `/app/routines/${ROUTINE}`);
    await expect(page.getByTestId(T.autonomy(ROUTINE))).toHaveAttribute("data-level", "recommend");
  });
});

test("GP16: an escalated notice shows the specialist hand-off and its evidence pack", async ({ page, weft }) => {
  let noticeId = "";
  await test.step("deliver a missing-filing notice and escalate it", async () => {
    await weft.post("/v1/sim/notices/deliver", { scenario: "ny_missing_filing" });
    const notice = await eventually(() => weft.notices(), (ns) => ns.find((n) => n.kind === "missing_filing"), "the missing-filing notice");
    noticeId = notice.id;
    const r = await weft.post<{ ok: boolean }>("/v1/tools/notices.escalate", { notice_id: noticeId, reason_code: "missing_filing" });
    expect(r.ok).toBe(true);
    expect((await weft.notice(noticeId)).status).toBe("escalated");
  });

  await test.step("the Compliance notice drawer names the specialist, the reason and the evidence", async () => {
    await openApp(page, `/app/compliance?notice=${noticeId}`);
    const box = page.getByTestId(T.noticeEscalation);
    await expect(box).toBeVisible();
    await expect(box).toContainText(/tax specialist \(simulated\)/i);
    await expect(box).toContainText(/a filing is missing/i);
    await expect(box).toContainText(noticeId);
    await expect(box).toContainText("parser extract");
  });
});
