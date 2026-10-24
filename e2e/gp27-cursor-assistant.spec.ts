// GP27. The cursor assistant (research/cursor-assistant.md; SPEC 9.12; packages/contracts/src/ext/assist.ts). Inside
// the app shell a single right-click opens the small Weft menu and a double right-click wakes the assistant and
// listens (speech recognition is replaced here by a fake that hears a fixed transcript); Ctrl or Cmd J opens the
// composer. Each question is an assist run on the scripted provider, or the instant resolver with no model at all.
// The spec checks the three answer kinds (point, go there, answer), show through typed intents and through a row,
// the refusal to approve, the deep link a show lands on, the handoff to the full agent (progress card, approval card,
// chips, a choice), a walkthrough with a refused step, view state kept in the link (tabs, the Time Off calendar's
// department and month), an offer row tagged as its offer, the hidden-icon setting, Stop on a handoff's progress
// card, and the phone layout. Every check that matters for safety reads the API back: the assistant never decides,
// submits or changes anything.
import type { Locator, Page } from "@playwright/test";
import { eventually, expect, openApp, SEED, test, tid, type WeftApi } from "./fixtures";
import { ASSIST_TID as A } from "../packages/contracts/src/ext/assist";
import { AGENT_PAGE_TID } from "../packages/contracts/src/ext/agent-page";
import { W2_BENEFITS_TID, W2_OFFBOARDING_TID, W2_ONBOARDING_TID, W3_SETTINGS, W3_TIMEOFF_TID } from "../packages/contracts/src/index";

/** A stand-in for the browser's speech recognition: it hears `window.__assistHeard` (partial words, then the whole). */
async function fakeSpeech(page: Page, heard: string): Promise<void> {
  await page.addInitScript((words: string) => {
    const w = window as unknown as Record<string, unknown>;
    w.__assistHeard = words;
    class FakeRecognition {
      lang = "en-US"; interimResults = true; continuous = false; maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      private live = true;
      start() {
        const text = String(w.__assistHeard ?? "");
        const half = text.split(" ").slice(0, 3).join(" ");
        const result = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
        setTimeout(() => { if (this.live) this.onresult?.({ resultIndex: 0, results: [result(half, false)] }); }, 150);
        setTimeout(() => { if (this.live) this.onresult?.({ resultIndex: 0, results: [result(text, true)] }); }, 350);
        setTimeout(() => { if (this.live) { this.live = false; this.onend?.(); } }, 450);
      }
      stop() { if (this.live) { this.live = false; this.onend?.(); } }
      abort() { this.live = false; }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  }, heard);
}

/** The tour's ring (the assistant reuses it) sits around the element: its box holds the element's centre. */
async function ringed(page: Page, target: Locator): Promise<void> {
  const ring = page.locator("[data-tour-ring]").last();
  await expect(ring).toBeVisible();
  await expect.poll(async () => {
    const r = await ring.boundingBox(), t = await target.boundingBox();
    if (!r || !t) return false;
    const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
    return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
  }, { message: "the ring is around the target" }).toBe(true);
}

/** Opens the composer with the hotkey and asks; returns the answer card. */
async function ask(page: Page, question: string): Promise<Locator> {
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const input = page.getByTestId(A.input);
  await expect(input).toBeFocused();
  await input.fill(question);
  await input.press("Enter");
  const card = page.getByTestId(A.popover);
  await expect(card).toBeVisible();
  return card;
}

/** Asks about the record under the pointer: a right-click on it, then Ask about this. */
async function askAbout(page: Page, target: Locator, question: string): Promise<Locator> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + box.height / 2);
  await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height / 2, { button: "right" });
  await page.getByTestId(A.menuAsk).click();
  await expect(page.getByTestId(A.composer)).toContainText("About:");
  const input = page.getByTestId(A.input);
  await input.fill(question);
  await input.press("Enter");
  const card = page.getByTestId(A.popover);
  await expect(card).toBeVisible();
  return card;
}

/** Closes whatever the assistant has open. */
async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(A.popover)).toHaveCount(0);
}

/** Ruth's vacation as a pending time_off.decide proposal: the time-off review routine files it for Ruth's approver. */
async function ruthsTimeOffProposal(weft: WeftApi): Promise<string> {
  await weft.post("/v1/routines/rt_time_off_requests/trigger", {});
  const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x) => x.command === "time_off.decide"), "the time-off review files Ruth's decision");
  return p.id;
}

async function setCanPropose(page: Page, on: boolean): Promise<void> {
  const res = await page.request.put("/api/v1/settings/agent", { data: { chatCanPropose: on }, headers: { "x-weft-principal": "usr_dana" } });
  expect(res.ok(), `PUT /v1/settings/agent (${W3_SETTINGS.chatCanPropose})`).toBe(true);
}

test.describe("GP27 the cursor assistant", () => {
  test("wakes by right-click, points at the Inbox's time-off approval, and refuses to approve it", async ({ page, weft }) => {
    const prp = await ruthsTimeOffProposal(weft);
    await fakeSpeech(page, "Where do I approve Ruth's time off?");
    await openApp(page, "/app/inbox");
    const card = page.getByTestId(tid.inboxCard(prp));
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-command", "time_off.decide");
    const heading = page.locator("main h1").first();
    const hb = (await heading.boundingBox())!;
    const spot = { x: hb.x + hb.width + 80, y: hb.y + hb.height / 2 };

    await test.step("a single right-click shows the Weft menu instead of the browser's; Escape closes it", async () => {
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      const menu = page.getByTestId(A.menu);
      await expect(menu).toBeVisible();
      await expect(menu.getByTestId(A.menuCopy)).toHaveText("Copy selected text");
      await expect(menu.getByTestId(A.menuCopy)).toBeDisabled();
      await expect(menu.getByTestId(A.menuAsk)).toHaveText("Ask about this");
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      // From the keyboard (the context menu key on a focused link), the menu gives focus back where it was.
      const nav = page.getByTestId("nav-inbox");
      await nav.focus();
      await nav.evaluate((el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10, button: 2 })); });
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(nav).toBeFocused();
      await page.waitForTimeout(450);
    });

    await test.step("a double right-click wakes it and listens; the instant resolver points at the Approve control", async () => {
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      await page.mouse.click(spot.x, spot.y, { button: "right" });
      await expect(page.getByTestId(A.composer)).toBeVisible();
      await expect(page.getByTestId(A.transcript)).toBeVisible();
      const popover = page.getByTestId(A.popover);
      await expect(popover).toBeVisible();
      await expect(popover).toContainText("Where do I approve Ruth's time off?");
      await expect(page.getByTestId(A.answer)).toContainText("Time-off decisions wait in the Inbox");
      await expect(page.getByTestId(A.bubble)).toHaveText("Approve it here");
      await ringed(page, card.getByTestId("inbox-approve"));
      const run = (await weft.agentRuns()).find((r) => r.trigger === "chat" && (r as { model?: string }).model === "resolver");
      expect(run, "the resolver answered without a model call").toBeTruthy();
      await dismiss(page);
    });

    await test.step("a name no card on the page holds is said plainly: another person's Approve is never ringed", async () => {
      const popover = await ask(page, "Where do I approve Zed's time off?");
      await expect(popover.getByTestId("assist-note")).toHaveText("Nothing on this page names Zed, so I did not point at anyone else's.");
      await expect(page.getByTestId(A.bubble)).toHaveCount(0);
      await expect(page.getByTestId(A.pointer)).toHaveCount(0);
      await dismiss(page);
    });

    await test.step("dismissed before its run is accepted, the run is cancelled as soon as its id is known", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      const runs = "**/api/v1/agent/runs";
      await page.route(runs, async (route) => { if (route.request().method() === "POST") await gate; await route.fallback(); });
      try {
        const accepted = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname));
        const cancel = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/agent\/runs\/run_[^/]+\/cancel$/.test(new URL(r.url()).pathname));
        await page.keyboard.press("ControlOrMeta+KeyJ");
        await page.getByTestId(A.input).fill("Where is the audit log?");
        await page.getByTestId(A.input).press("Enter");
        await expect(page.getByTestId(A.popover)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId(A.popover)).toHaveCount(0);
        release();
        const runId = ((await (await accepted).json()) as { runId: string }).runId;
        expect(new URL((await cancel).url()).pathname).toBe(`/api/v1/agent/runs/${runId}/cancel`);
        // Nothing was played for it: the person dismissed it.
        await page.waitForTimeout(400);
        await expect(page).toHaveURL(/\/app\/inbox/);
      } finally {
        await page.unroute(runs);
      }
    });

    await test.step("with a modal app menu open, the composer still opens, takes focus and takes typing", async () => {
      await page.getByTestId("viewing-as").click();
      await expect(page.getByRole("menu").first()).toBeVisible();
      await page.keyboard.press("ControlOrMeta+KeyJ");
      const input = page.getByTestId(A.input);
      await expect(input).toBeFocused();
      await page.keyboard.type("where is");
      await expect(input).toHaveValue("where is");
      await expect(page.locator('[role=menu][data-state="open"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.composer)).toHaveCount(0);
    });

    await test.step("asked to approve, it shows the approval card for the person and presses nothing", async () => {
      const actions = (await weft.actions()).length;
      const popover = await askAbout(page, card, "Approve this");
      await expect(popover.getByTestId("assist-note")).toHaveText("Shown, not pressed: only you can make that change.");
      await expect(popover.getByTestId(A.card)).toBeVisible();
      await expect(popover.getByTestId(A.card)).toContainText("Ruth Okoro");
      await expect(page.getByTestId(A.answer)).toBeVisible();
      await page.waitForTimeout(500);
      expect((await weft.proposal(prp)).status, "the proposal still waits for a person").toBe("pending");
      expect((await weft.actions()).length, "nothing was decided").toBe(actions);
      await dismiss(page);
    });
  });

  test("goes there, shows through intents and a row, answers with a citation, and the deep link reopens the view", async ({ page, weft }) => {
    await openApp(page, "/app/inbox");

    await test.step("go there: the Oct 30 draft opens with its Needs review section ringed", async () => {
      await ask(page, "Show me the Oct 30 payroll flags");
      await expect(page).toHaveURL(new RegExp(`/app/payroll/${SEED.draftRun}`));
      await expect(page.getByTestId(A.bubble)).toHaveText("Needs review");
      await ringed(page, page.locator('[data-tour~="payroll-needs-review"]').first());
      await dismiss(page);
    });

    await test.step("answer: a grounded count that cites its result, with Continue in Agent", async () => {
      const popover = await ask(page, "How many paychecks need review on this draft?");
      // The composer gave way to the card, which takes focus: its controls are the next Tab stops.
      await expect(popover).toBeFocused();
      const answer = popover.getByTestId(A.answer);
      await expect(answer).toContainText(`${SEED.needsReview} paychecks need review on this draft`);
      const cite = answer.getByTestId("agent-answer-cite");
      await expect(cite).toHaveCount(1);
      await expect(cite).toHaveAttribute("data-cite", /^res_/);
      await expect(cite).toHaveAttribute("href", /^\/app\/runs\/run_\d+#res_/);
      const cont = popover.getByTestId(A.continue);
      await expect(cont).toHaveText(/Continue in Agent/);
      await expect(cont).toHaveAttribute("href", /\/app\/agent\?thread=thr_[0-9a-f]{20}$/);
      const href = (await cont.getAttribute("href"))!;
      // A right-click opens the menu over the answer and the answer stays (opening a menu is not a choice); the first
      // Escape closes the menu only.
      const h1 = (await page.locator("main h1").first().boundingBox())!;
      await page.mouse.click(h1.x + h1.width + 40, h1.y + h1.height / 2, { button: "right" });
      await expect(page.getByTestId(A.menu)).toBeVisible();
      await expect(answer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.menu)).toHaveCount(0);
      await expect(answer).toBeVisible();
      await page.waitForTimeout(450);
      await dismiss(page);
      await page.goto(href);
      await expect(page.getByText("How many paychecks need review on this draft?").first()).toBeVisible();
      await page.goto(`/app/payroll/${SEED.draftRun}`);
    });

    await test.step("show a row: asked about the row under the pointer, it opens that paycheck", async () => {
      const row = page.getByTestId("payroll-row-wrk_0026");
      await expect(row).toBeVisible();
      await askAbout(page, row, "Open this row");
      const drawer = page.getByTestId("paycheck-drawer");
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(/[?&]paycheck=wrk_0026/);
      // The first Escape is the assistant's: its card closes and the drawer it opened stays.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.popover)).toHaveCount(0);
      await expect(drawer).toBeVisible();
      // A link to this page replaces its view state, as the same link pasted shows it: the drawer it does not name
      // closes, and the band it names is ringed (not reported as covered by the drawer).
      await ask(page, "Show me the needs review section");
      await expect(drawer).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/app/payroll/${SEED.draftRun}$`));
      await ringed(page, page.locator('[data-tour~="payroll-needs-review"]').first());
      await expect(page.getByTestId("assist-note")).toHaveCount(0);
      await dismiss(page);
    });

    await test.step("intent one: from Home, Lena's paycheck on the Oct 30 run opens with the drawer ringed", async () => {
      await openApp(page, "/app");
      await ask(page, "Show me Lena's paycheck on the Oct 30 run");
      await expect(page).toHaveURL(new RegExp(`/app/payroll/${SEED.draftRun}\\?paycheck=wrk_0026$`));
      const drawer = page.getByTestId("paycheck-drawer");
      await expect(drawer).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Lena Brooks" })).toBeVisible();
      await ringed(page, drawer);
      await expect(page.getByTestId(A.answer)).toContainText("Here is Lena Brooks's paycheck");
    });

    await test.step("the same link pasted into the address bar opens the same view", async () => {
      const url = page.url();
      await page.goto("about:blank");
      await page.goto(url);
      const drawer = page.getByTestId("paycheck-drawer");
      await expect(drawer).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Lena Brooks" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/app/payroll/${SEED.draftRun}$`));
    });

    await test.step("intent two: a tab of a person's record, through people.openTab", async () => {
      await ask(page, "Show me Lena's pay tab");
      await expect(page).toHaveURL(/\/app\/people\/wrk_0026\?tab=pay$/);
      await expect(page.getByRole("tab", { name: "Pay and tax" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId(A.bubble)).toHaveText("Pay and tax");
      await dismiss(page);
    });

    await test.step("a notice written into the link in place opens its drawer, and closing it takes it out of the link", async () => {
      const n = (await weft.notices())[0]!;
      await openApp(page, "/app/compliance?tab=rates");
      // What setUrlState does (lib/url-state.ts): replaceState, then the event every page hook listens for.
      await page.evaluate((id) => { history.replaceState(history.state, "", `/app/compliance?notice=${id}`); window.dispatchEvent(new Event("weft:url-state")); }, n.id);
      await expect(page.getByTestId("notice-detail")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("notice-detail")).toHaveCount(0);
      await expect(page).not.toHaveURL(/notice=/);
    });

    // Nothing in this test wrote anything.
    expect((await weft.actions()).filter((a) => a.actorKind === "agent")).toHaveLength(0);
    expect(await weft.proposals("pending")).toHaveLength(0);
  });

  test("hands complicated requests to the full agent: progress, approval card, chips and a choice", async ({ page, weft }) => {
    await openApp(page, "/app");

    await test.step("analysis: the progress card, then the cited answer with Show me chips", async () => {
      const popover = await ask(page, "Compare the last three pay runs and show me the outliers");
      const progress = popover.getByTestId(A.progress);
      await expect(progress).toBeVisible();
      await expect(progress.getByTestId(A.openInAgent)).toHaveAttribute("href", /\/app\/agent\?thread=thr_/);
      await expect(progress).toHaveAttribute("data-status", "done");
      await expect(progress.getByTestId(A.step).first()).toBeVisible();
      await expect(popover.getByTestId(A.answer)).toContainText("the open draft stands out");
      const chips = popover.getByTestId(A.chip);
      await expect(chips.first()).toBeVisible();
      expect(await chips.count()).toBeLessThanOrEqual(4);
      await chips.first().click();
      await expect(page).toHaveURL(/\/app\/payroll\/pay_/);
      await dismiss(page);
    });

    await test.step("change: handed off by code, the chat run files a proposal, and its card is the person's to press", async () => {
      await setCanPropose(page, true);
      try {
        const actions = (await weft.actions()).length;
        const popover = await ask(page, "Pay Hollis Grey an off-cycle bonus of $1,500.00 with payday Oct 27");
        await expect(popover.getByTestId(A.progress)).toBeVisible();
        const p = await eventually(() => weft.proposals("pending"), (ps) => ps.find((x) => x.command === "payroll.propose_off_cycle"), "the handed-off chat run files the off-cycle proposal");
        await expect(popover.getByTestId(A.card)).toContainText("Hollis Grey");
        // The closing show opens the Inbox on that proposal and rings its card.
        await expect(page).toHaveURL(new RegExp(`/app/inbox\\?proposal=${p.id}$`));
        await ringed(page, page.getByTestId(tid.inboxCard(p.id)));
        expect((await weft.proposal(p.id)).status).toBe("pending");
        expect((await weft.actions()).length, "proposed, not paid").toBe(actions);
        const runs = await weft.agentRuns();
        const chat = runs.find((r) => r.trigger === "chat" && r.threadId && runs.some((o) => o.id !== r.id && o.threadId === r.threadId));
        expect(chat, "the assist run and its chat run share one thread").toBeTruthy();
      } finally {
        await setCanPropose(page, false);
      }
      await dismiss(page);
    });

    await test.step("ambiguity: one question with the candidates as buttons; the choice continues the thread", async () => {
      await openApp(page, "/app/people");
      const popover = await ask(page, "Open the account executive's record");
      await expect(popover.getByTestId(A.answer)).toContainText("Which one do you mean?");
      const choices = popover.getByTestId(A.choice);
      await expect(choices).toHaveCount(2);
      await popover.locator(`[data-testid="${A.choice}"][data-entity="wrk_0026"]`).click();
      await expect(page).toHaveURL(/\/app\/people\/wrk_0026$/);
      await expect(page.getByTestId(A.answer)).toContainText("Here is");
      await dismiss(page);
    });
  });

  test("walkthroughs play with Next and Back, and a step on a control that changes data is refused", async ({ page, weft }) => {
    await openApp(page, "/app");

    await test.step("the help corpus plays a five-step walkthrough on the tour's ring", async () => {
      await ask(page, "How do I run payroll end to end?");
      const walk = page.getByTestId(A.walk);
      await expect(walk).toBeVisible();
      await expect(walk).toContainText("Step 1 of 5");
      // Once the run's card gives way, the walkthrough holds focus: Back and Next are the next Tab stops.
      await expect(page.getByTestId(A.popover)).toHaveCount(0);
      await expect(walk).toBeFocused();
      await expect(page).toHaveURL(/\/app\/payroll$/);
      await expect(walk.locator("[data-found]")).toHaveAttribute("data-found", "true");
      await expect(page.getByTestId(A.walkBack)).toBeDisabled();
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 2 of 5");
      await page.getByTestId(A.walkBack).click();
      await expect(walk).toContainText("Step 1 of 5");
      await page.keyboard.press("Escape");
      await expect(walk).toHaveCount(0);
    });

    await test.step("Back to a step with no route of its own returns to the page it was shown on", async () => {
      await openApp(page, "/app");
      await ask(page, "How do I run payroll end to end?");
      const walk = page.getByTestId(A.walk);
      const found = walk.locator("[data-found]");
      await expect(walk).toContainText("Step 1 of 5");
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 2 of 5");
      // Following the step before: the person opens the draft run themselves (the walkthrough card sits over its
      // row at this size, so the link is followed as its own click), and the band is found there.
      await page.getByTestId(`payroll-run-${SEED.draftRun}`).dispatchEvent("click");
      await expect(found).toHaveAttribute("data-found", "true");
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 3 of 5");
      await expect(found).toHaveAttribute("data-found", /true|false/);
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 4 of 5");
      await expect(page).toHaveURL(/\/app\/inbox/);
      await page.getByTestId(A.walkBack).click();
      await expect(walk).toContainText("Step 3 of 5");
      await expect(page).toHaveURL(new RegExp(`/app/payroll/${SEED.draftRun}`));
      await page.keyboard.press("Escape");
      await expect(walk).toHaveCount(0);
    });

    await test.step("asked to walk through submitting, the submit step is refused and never ringed", async () => {
      await openApp(page, `/app/payroll/${SEED.draftRun}`);
      const before = await weft.payroll(SEED.draftRun);
      await ask(page, "Walk me through submitting the draft");
      const walk = page.getByTestId(A.walk);
      await expect(walk).toBeVisible();
      // The run's first plan rang the Submit button: the executor refused that step, and the plan it played instead
      // only points at the review and the Inbox.
      const runs = await weft.get<{ data: { id: string; question: string | null }[] }>("/v1/agent/runs", { trigger: "chat", limit: 20 });
      const run = runs.data.find((r) => r.question === "Walk me through submitting the draft")!;
      const trace = await weft.get<{ steps: { kind: string; toolName: string | null; outcome: string | null }[] }>(`/v1/agent/runs/${run.id}/trace`);
      expect(trace.steps.filter((s) => s.toolName === "ui__steps").map((s) => s.outcome)).toEqual(["refused:NOT_PERMITTED", "ok"]);
      for (let i = 0; i < 6 && !(await page.getByTestId(A.walkNext).textContent())?.includes("Done"); i++) {
        await expect(walk).not.toContainText(/Then submit the run/);
        await page.getByTestId(A.walkNext).click();
      }
      await expect(walk).not.toContainText(/Then submit the run/);
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toHaveCount(0);
      expect((await weft.payroll(SEED.draftRun)).status).toBe(before.status);
    });
  });

  test("the review's client fixes: the word a right-click selects, a waiting step, Back's focus, and the label read out", async ({ page }) => {
    await test.step("a right-click's own word selection (as macOS makes one) is never the person's: no Copy, no selection sent", async () => {
      await openApp(page, "/app");
      // WebKit on macOS selects the word under the pointer before contextmenu fires; this does the same, first.
      await page.evaluate(() => window.addEventListener("contextmenu", (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const r = document.createRange();
        r.selectNodeContents(t);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(r);
      }, { capture: true }));
      const h1 = page.locator("main h1").first();
      const box = (await h1.boundingBox())!;
      await page.mouse.click(box.x + 10, box.y + box.height / 2, { button: "right" });
      await expect(page.getByTestId(A.menu)).toBeVisible();
      await expect(page.getByTestId(A.menuCopy)).toBeDisabled();
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? ""), "the page's selection is as it was").toBe("");
      await page.getByTestId(A.menuAsk).click();
      const input = page.getByTestId(A.input);
      await expect(input).toBeFocused();
      await input.fill("Where is the clock?");
      const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname));
      await input.press("Enter");
      const body = (await sent).postDataJSON() as { assist: { cursor: { selection: unknown } } };
      expect(body.assist.cursor.selection).toBeNull();
      await dismiss(page);
      // A selection the person made before the press is theirs: Copy offers it.
      await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("main h1")!); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(r); });
      const words = (await h1.textContent())!.trim();
      const again = (await h1.boundingBox())!;
      // Past the double right-click window: this press is a first one, not the second of a pair.
      await page.waitForTimeout(450);
      await page.mouse.click(again.x + 10, again.y + again.height / 2, { button: "right" });
      await expect(page.getByTestId(A.menuCopy)).toBeEnabled();
      expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe(words);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.menu)).toHaveCount(0);
    });

    await test.step("a pointer's label is read out through the card's live region, which was open before it", async () => {
      await openApp(page, "/app/inbox");
      const card = await ask(page, "Where is the clock?");
      await expect(card).toHaveAttribute("aria-live", "polite");
      await expect(page.getByTestId(A.bubble)).toHaveText("Clock and persona");
      await expect(page.getByTestId(A.bubble)).toHaveAttribute("aria-hidden", "true");
      await expect(card.getByTestId(A.pointed)).toHaveText("Clock and persona");
      await dismiss(page);
    });

    await test.step("Back to the first step keeps focus in the walkthrough, on Next", async () => {
      await openApp(page, "/app");
      await ask(page, "How do I run payroll end to end?");
      const walk = page.getByTestId(A.walk);
      await expect(walk).toContainText("Step 1 of 5");
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 2 of 5");
      await page.getByTestId(A.walkBack).focus();
      await page.keyboard.press("Enter");
      await expect(walk).toContainText("Step 1 of 5");
      await expect(page.getByTestId(A.walkNext)).toBeFocused();
      await page.waitForTimeout(300);
      await expect(page.getByTestId(A.walkNext)).toBeFocused();
    });

    await test.step("a waiting step finds its part of the page when it appears there, with no move", async () => {
      const walk = page.getByTestId(A.walk);
      const found = walk.locator("[data-found]");
      await page.getByTestId(A.walkNext).click();
      await expect(walk).toContainText("Step 2 of 5");
      // Needs review is on a pay run's page, not the list: the step waits.
      await expect(found).toHaveAttribute("data-found", "false", { timeout: 10_000 });
      await expect(page).toHaveURL(/\/app\/payroll$/);
      // A section that renders late on this same page (as a drawer or a tab opened in place would).
      await page.evaluate(() => {
        const s = document.createElement("section");
        s.setAttribute("data-tour", "payroll-needs-review");
        s.textContent = "Needs review";
        // Clear of the walkthrough card, which sits where the question was asked.
        s.style.cssText = "position: fixed; left: 300px; bottom: 32px; width: 220px; height: 64px; border: 1px solid; background: white";
        document.querySelector("main")!.append(s);
      });
      await expect(found).toHaveAttribute("data-found", "true");
      await page.keyboard.press("Escape");
      await expect(walk).toHaveCount(0);
    });
  });

  test("untrusted titles stay untrusted, records open through their link, and the card keeps out of the person's way", async ({ page, weft }) => {
    /** Asks, and returns the request the page sent and the run it started. */
    const askSent = async (question: string) => {
      const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname));
      const accepted = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname));
      const card = await ask(page, question);
      const body = (await sent).postDataJSON() as { assist: { screen: { items: { kind: string; label: string; untrusted?: boolean }[] }; cursor: { layer: { label: string } | null } } };
      const runId = ((await (await accepted).json()) as { runId: string }).runId;
      return { card, body, runId };
    };
    const n = (await weft.notices())[0]!;

    await test.step("a notice's title (the agency's words) is never a trusted label, in the list or as its drawer's name", async () => {
      await openApp(page, "/app/compliance?tab=notices");
      await expect(page.getByTestId(tid.noticeRow(n.id))).toBeVisible();
      const list = await askSent("What is on this list?");
      for (const i of list.body.assist.screen.items) if (!i.untrusted) expect(i.label, `[${i.kind}] is the app's words`).not.toContain(n.title);
      await dismiss(page);
      await page.getByTestId(tid.noticeRow(n.id)).click();
      await expect(page.getByTestId("notice-detail")).toBeVisible();
      const drawer = await askSent("What is this?");
      const items = drawer.body.assist.screen.items;
      for (const i of items) if (!i.untrusted) expect(i.label, `[${i.kind}] is the app's words`).not.toContain(n.title);
      expect(items.some((i) => i.kind === "dialog" && i.untrusted && i.label.includes(n.title)), "the drawer's name is sent as untrusted").toBe(true);
      expect(drawer.body.assist.cursor.layer?.label ?? "").not.toContain(n.title);
      const trace = await weft.get<{ run: { tainted: boolean } }>(`/v1/agent/runs/${drawer.runId}/trace`);
      expect(trace.run.tainted, "a run that saw the title is tainted").toBe(true);
      await dismiss(page);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("notice-detail")).toHaveCount(0);
    });

    await test.step("the label bubble and the pointer follow the ringed section through a scroll", async () => {
      await openApp(page, `/app/payroll/${SEED.draftRun}`);
      await ask(page, "Show me the needs review section");
      const band = page.locator('[data-tour~="payroll-needs-review"]').first();
      await ringed(page, band);
      const bubble = page.getByTestId(A.bubble);
      await expect(bubble).toBeVisible();
      const near = async () => {
        const [r, b] = [await page.locator("[data-tour-ring]").last().boundingBox(), await bubble.boundingBox()];
        return !!r && !!b && b.y >= r.y - 48 && b.y <= r.y + r.height + 48;
      };
      expect(await near()).toBe(true);
      const box = (await band.boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 10);
      await page.mouse.wheel(0, 160);
      await expect.poll(async () => Math.round((await band.boundingBox())!.y)).not.toBe(Math.round(box.y));
      await expect.poll(near, { message: "the bubble stays beside the ring after the scroll" }).toBe(true);
      await dismiss(page);
    });

    await test.step("show open on a People row follows the row's own link to the person", async () => {
      await openApp(page, "/app/people");
      await askAbout(page, page.getByTestId("people-row-wrk_0026"), "Open this row");
      await expect(page).toHaveURL(/\/app\/people\/wrk_0026$/);
      await dismiss(page);
    });

    await test.step("the top bar's pill is pointed at in place, and Escape leaves focus in the field the person moved to", async () => {
      await openApp(page, "/app/people");
      const card = await ask(page, "Where do I switch persona?");
      await expect(page.getByTestId(A.bubble)).toHaveText("Clock and persona");
      await expect(page).toHaveURL(/\/app\/people$/);
      const filter = page.getByRole("textbox", { name: "Filter people" });
      await filter.click();
      await page.keyboard.type("Le");
      await expect(card).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.popover)).toHaveCount(0);
      await expect(filter).toBeFocused();
      await expect(filter).toHaveValue("Le");
    });

    await test.step("Continue in Agent on the Agent page opens the new conversation there", async () => {
      await openApp(page, "/app/agent");
      const question = "Where do I switch persona?";
      const card = await ask(page, question);
      const cont = card.getByTestId(A.continue);
      await expect(cont).toBeVisible();
      const href = (await cont.getAttribute("href"))!;
      await cont.click();
      await expect(page).toHaveURL(new RegExp(`${href.replace(/[?]/g, "\\?")}$`));
      // The conversation itself (its turn), not only the list of conversations: the page took the new thread.
      await expect(page.getByTestId("agent-page-question").first()).toHaveText(question);
      await page.keyboard.press("Escape");
    });

    // Nothing in this test wrote anything.
    expect((await weft.actions()).filter((a) => a.actorKind === "agent")).toHaveLength(0);
  });

  test("pages keep their tabs and the calendar's department and month in the link, and an offer row names its offer", async ({ page, weft }) => {
    await test.step("Benefits and the Agent page: a tab opens from its link, and choosing one writes it in place", async () => {
      await openApp(page, "/app/benefits?tab=reconciliation");
      await expect(page.getByTestId(W2_BENEFITS_TID.tabRecon)).toHaveAttribute("aria-selected", "true");
      await page.getByTestId(W2_BENEFITS_TID.tabPlans).click();
      await expect(page).toHaveURL(/\/app\/benefits$/);
      await page.getByTestId(W2_BENEFITS_TID.tabEnrollment).click();
      await expect(page).toHaveURL(/\/app\/benefits\?tab=enrollment$/);
      await page.reload();
      await expect(page.getByTestId(W2_BENEFITS_TID.tabEnrollment)).toHaveAttribute("aria-selected", "true");
      await openApp(page, "/app/agent?tab=background");
      await expect(page.getByTestId(AGENT_PAGE_TID.backgroundTab)).toHaveAttribute("aria-selected", "true");
      await page.getByTestId(AGENT_PAGE_TID.threadsTab).click();
      await expect(page.getByTestId(AGENT_PAGE_TID.threadsTab)).toHaveAttribute("aria-selected", "true");
      await expect(page).toHaveURL(/\/app\/agent$/);
    });

    await test.step("Time Off: the calendar opens on the link's department and month, and Next and the picker write them", async () => {
      await openApp(page, "/app/time-off?tab=calendar&filter.dept=dpt_people&filter.month=2026-12");
      await expect(page.getByTestId(W3_TIMEOFF_TID.calendar)).toBeVisible();
      const dept = page.getByLabel("Department");
      await expect(dept).toHaveValue("dpt_people");
      await expect(page.getByText("December 2026", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next month" }).click();
      await expect(page.getByText("January 2027", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/[?&]filter\.month=2027-01(&|$)/);
      await dept.selectOption("dpt_hardware");
      await expect(page).toHaveURL(/[?&]filter\.dept=dpt_hardware(&|$)/);
      // The same link pasted opens the same calendar.
      const url = page.url();
      await page.goto("about:blank");
      await page.goto(url);
      await expect(page.getByLabel("Department")).toHaveValue("dpt_hardware");
      await expect(page.getByText("January 2027", { exact: true })).toBeVisible();
      // A value of no shape the page keeps reads as absent: the calendar opens on its usual month.
      await openApp(page, "/app/time-off?tab=calendar&filter.month=next+month");
      await expect(page.getByTestId(W3_TIMEOFF_TID.calendar)).toBeVisible();
      await expect(page.getByText("January 2027", { exact: true })).toHaveCount(0);
    });

    await test.step("Hiring: asked about the offer row under the pointer, the record is the offer itself", async () => {
      await openApp(page, "/app/hiring");
      const row = page.locator(`[data-testid="${W2_ONBOARDING_TID.offerRow}"][data-offer="offr_0001"]`);
      await expect(row).toHaveAttribute("data-entity", "offr_0001");
      await expect(row).toHaveAttribute("data-entity-kind", "offer");
      await row.scrollIntoViewIfNeeded();
      const box = (await row.boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: "right" });
      await page.getByTestId(A.menuAsk).click();
      const composer = page.getByTestId(A.composer);
      await expect(composer).toContainText("About:");
      await expect(composer.locator('[data-entity="offr_0001"]')).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(composer).toHaveCount(0);
    });

    expect((await weft.actions()).filter((a) => a.actorKind === "agent")).toHaveLength(0);
  });

  test("the icon can be hidden from Viewing as, and Stop ends a handed-off run before it writes anything", async ({ page, weft }) => {
    await openApp(page, "/app");
    const icon = page.getByTestId(A.icon);
    const point = async () => { await page.mouse.move(700, 420); await page.mouse.move(720, 440); };

    await test.step("Hide the assistant icon: it stays hidden after a reload, and Ctrl or Cmd J and the right-click menu still work", async () => {
      await point();
      await expect(icon).not.toHaveAttribute("aria-hidden", "true");
      await page.getByTestId("viewing-as").click();
      const toggle = page.getByTestId(A.toggle);
      await expect(toggle).toHaveAttribute("data-on", "true");
      await expect(toggle).toContainText("Hide the assistant icon");
      await toggle.click();
      await point();
      await expect(icon).toHaveAttribute("aria-hidden", "true");
      await page.reload();
      await expect(page.getByTestId("sim-clock")).toBeVisible();
      await point();
      await page.waitForTimeout(300);
      await expect(icon).toHaveAttribute("aria-hidden", "true");
      await page.keyboard.press("ControlOrMeta+KeyJ");
      await expect(page.getByTestId(A.input)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.composer)).toHaveCount(0);
      const h1 = (await page.locator("main h1").first().boundingBox())!;
      await page.mouse.click(h1.x + h1.width + 80, h1.y + h1.height / 2, { button: "right" });
      await expect(page.getByTestId(A.menu)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.menu)).toHaveCount(0);
      await page.waitForTimeout(450);
      // And back on.
      await page.getByTestId("viewing-as").click();
      await expect(toggle).toHaveAttribute("data-on", "false");
      await expect(toggle).toContainText("Show the assistant icon");
      await toggle.click();
      await point();
      await expect(icon).not.toHaveAttribute("aria-hidden", "true");
    });

    await test.step("Stop on the progress card cancels the chat run while it works; no proposal or action is written", async () => {
      const actions = (await weft.actions()).length;
      const proposals = (await weft.proposals()).length;
      const popover = await ask(page, "Give Felix Wainwright a raise of 2 percent from November 16");
      const progress = popover.getByTestId(A.progress);
      await expect(progress).toBeVisible();
      // The chat run's first model step is held (scenarios/chat_held_raise.json), so the run is still working here.
      const stop = progress.getByTestId(A.stop);
      await expect(stop).toBeVisible();
      // A cancel the server refuses is not a stop: the card says so, and Stop stays to press again.
      const isCancel = (u: URL) => /\/api\/v1\/agent\/runs\/run_[^/]+\/cancel$/.test(u.pathname);
      await page.route(isCancel, (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ _tag: "Unavailable", message: "Try again" }) }));
      await stop.click();
      await expect(progress.getByTestId(A.stopFailed)).toBeVisible();
      await expect(stop).toBeVisible();
      await expect(progress).not.toContainText("Stopped.");
      await page.unroute(isCancel);
      const cancel = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/agent\/runs\/run_[^/]+\/cancel$/.test(new URL(r.url()).pathname));
      await stop.click();
      const runId = /\/runs\/(run_[^/]+)\/cancel$/.exec(new URL((await cancel).url()).pathname)![1]!;
      await expect(stop).toHaveCount(0);
      await expect(progress.getByRole("status")).toBeVisible();
      // The heading says it stopped, never that the agent is still working.
      await expect(progress).toContainText("The agent stopped");
      await expect(progress).not.toContainText("The agent is working on it");
      const run = await eventually(() => weft.get<{ id: string; status: string; trigger: string; recipe?: string | null }>(`/v1/agent/runs/${runId}`), (r) => (r.status === "cancelled" ? r : undefined), "the chat run ends cancelled");
      expect(run.trigger).toBe("chat");
      await expect(progress).toHaveAttribute("data-status", "cancelled");
      await page.waitForTimeout(500);
      expect((await weft.get<{ status: string }>(`/v1/agent/runs/${runId}`)).status, "it stays cancelled").toBe("cancelled");
      expect((await weft.proposals()).length, "no proposal was filed").toBe(proposals);
      expect((await weft.actions()).length, "nothing changed").toBe(actions);
      await dismiss(page);
    });

    await test.step("Escape before the progress card shows ends the request: a handoff it already made is cancelled too", async () => {
      const proposals = (await weft.proposals()).length;
      await page.keyboard.press("ControlOrMeta+KeyJ");
      const input = page.getByTestId(A.input);
      await expect(input).toBeFocused();
      await input.fill("Give Felix Wainwright a raise of 2 percent from November 16");
      const accepted = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname));
      await input.press("Enter");
      // The resolver hands a change off at once; the card still says Working while the client learns of it.
      const { runId } = (await (await accepted).json()) as { runId: string };
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.popover)).toHaveCount(0);
      type Ended = { run: { status: string }; handoff?: { to: string | null } };
      const t = await eventually(() => weft.get<Ended>(`/v1/agent/runs/${runId}/trace`), (x) => (x.run.status === "done" || x.run.status === "cancelled" ? x : undefined), "the assist run ends");
      if (t.handoff?.to) await eventually(() => weft.get<{ status: string }>(`/v1/agent/runs/${t.handoff!.to}`), (r) => (r.status === "cancelled" ? r : undefined), "the chat run it handed to is cancelled");
      else expect(t.run.status).toBe("cancelled");
      expect((await weft.proposals()).length, "no proposal was filed").toBe(proposals);
    });
  });

  test("inside a drawer or the command menu it is placed, reachable and leaves what the drawer holds alone", async ({ page }) => {
    const isAsk = (r: { method(): string; url(): string }) => r.method() === "POST" && /\/api\/v1\/agent\/runs$/.test(new URL(r.url()).pathname);
    const intents = (r: { postDataJSON(): unknown }) => (r.postDataJSON() as { assist: { screen: { intents: string[] } } }).assist.screen.intents;
    await openApp(page, "/app/people/wrk_0026");

    await test.step("with no layer open, the record's tabs are a page intent", async () => {
      await expect(page.getByRole("tab", { name: "Pay and tax" })).toBeVisible();
      const sent = page.waitForRequest(isAsk);
      const card = await ask(page, "Where is Viewing as?");
      expect(intents(await sent)).toContain("tab.select");
      // The voice toggle keeps its name; aria-pressed says whether it is on.
      await expect(card.getByTestId(A.voiceOut)).toHaveAttribute("aria-label", "Speak answers");
      await expect(card.getByTestId(A.voiceOut)).toHaveAttribute("aria-pressed", "false");
      await dismiss(page);
    });

    await test.step("in the Off-cycle pay drawer the composer is read by assistive tech, and nothing behind the drawer is pressed", async () => {
      await page.getByTestId(W2_OFFBOARDING_TID.personOffCycle).click();
      const bonus = page.getByTestId(W2_OFFBOARDING_TID.offCycleBonus);
      await bonus.fill("250.00");
      await page.keyboard.press("ControlOrMeta+KeyJ");
      // By role: a composer under an aria-hidden container (the drawer hid the body's other children) is not found.
      const input = page.getByRole("textbox", { name: "Ask about this page..." });
      await expect(input).toBeFocused();
      // A held hotkey repeats: only the press itself toggles the composer.
      await page.evaluate(() => { for (let i = 0; i < 5; i++) document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, metaKey: true, repeat: true, bubbles: true, cancelable: true })); });
      await expect(input).toBeFocused();
      const sent = page.waitForRequest(isAsk);
      await input.fill("Where is Viewing as?");
      await input.press("Enter");
      // The tabs sit behind the drawer: not offered, so the assistant never presses one (that would close the drawer).
      expect(intents(await sent)).not.toContain("tab.select");
      await expect(page.getByTestId(A.popover)).toBeVisible();
      await dismiss(page);
      await expect(bonus).toHaveValue("250.00");
      await page.keyboard.press("Escape");
      await expect(bonus).toHaveCount(0);
    });

    await test.step("over the command menu the composer opens where it can be seen and typed into", async () => {
      await page.keyboard.press("ControlOrMeta+KeyK");
      await expect(page.getByRole("dialog", { name: "Search and navigate" })).toBeVisible();
      await page.keyboard.press("ControlOrMeta+KeyJ");
      const input = page.getByTestId(A.input);
      await expect(input).toBeFocused();
      // Not offset by the menu's box or clipped by it: what is at the field's middle is the field.
      const reachable = await input.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight && (hit === el || el.contains(hit));
      });
      expect(reachable).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(A.composer)).toHaveCount(0);
    });
  });

  test("on a phone (390 by 844) the answer is a bottom sheet with no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, `/app/payroll/${SEED.draftRun}`);
    const popover = await ask(page, "How many paychecks need review on this draft?");
    await expect(popover.getByTestId(A.answer)).toContainText(`${SEED.needsReview} paychecks need review`);
    // Once its short pop-in animation has settled: 16 px from each side and from the bottom.
    await expect.poll(async () => { const b = (await popover.boundingBox())!; return [b.x, b.x + b.width, b.y + b.height].map(Math.round); }).toEqual([16, 390 - 16, 844 - 16]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(popover.getByTestId(A.continue)).toBeVisible();
    await dismiss(page);
    // A ring the answer explains stays above the sheet once the answer has grown it from Working.
    const sheet = await ask(page, "Show me the needs review section");
    await expect(sheet.getByTestId(A.answer)).toBeVisible();
    const band = page.locator('[data-tour~="payroll-needs-review"]').first();
    await ringed(page, band);
    await page.waitForTimeout(400);
    const [b, s] = [(await band.boundingBox())!, (await sheet.boundingBox())!];
    expect(b.y, "the band's top is above the sheet").toBeLessThan(s.y);
    expect(b.y).toBeGreaterThanOrEqual(0);
    await dismiss(page);
  });

  test.describe("on a touch phone", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    test("the docked icon steps aside from an open drawer, whose footer button sits under its corner", async ({ page }) => {
      await openApp(page, `/app/payroll/${SEED.draftRun}`);
      const icon = page.getByTestId(A.icon);
      // Whether a tap at the icon's spot reaches the icon (it takes taps only when it is shown).
      const takesTap = () => icon.evaluate((el) => { const r = el.getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-testid="assist-icon"]'); });
      await expect.poll(takesTap).toBe(true);
      await page.goto(`/app/payroll/${SEED.draftRun}?paycheck=wrk_0026`);
      await expect(page.getByTestId("paycheck-drawer")).toBeVisible();
      await expect.poll(takesTap).toBe(false);
    });
  });

  test("outside the app shell the browser keeps its own menu", async ({ page }) => {
    await page.goto("/");
    const prevented = await page.evaluate(() => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await expect(page.getByTestId(A.menu)).toHaveCount(0);
    await expect(page.getByTestId(A.icon)).toHaveCount(0);
  });
});
