// GP26. The Agent page (README "The Agent page"; packages/contracts/src/ext/agent-page.ts). Agent in the sidebar opens
// the full-page agent with the side panel closed; the recorded showcase conversations (real runs on the live model,
// packages/seed/src/rich/showcase.ts) show as threads titled by their first question and the routine runs as
// background work; a recorded conversation opens with every turn; a new question starts a thread, a follow-up stays in
// it and its context pack holds the first turn; the deep link reloads; and the page holds at 1440 by 900 and 390 by
// 844. The recorded runs live in the rich profile, so this spec resets the e2e world to rich and back to base
// afterwards (every other spec runs on base). New questions run on the scripted provider.
import type { Page } from "@playwright/test";
import { expect, openApp, test, TID, type AgentRunRow } from "./fixtures";
import { AGENT_PAGE_TID as T } from "../packages/contracts/src/ext/agent-page";
import { W3_CHAT_TID, W3_SHELL_TID } from "../packages/contracts/src/index";

type Row = AgentRunRow & { question: string | null; askedFrom: string };

/** No sideways scroll on the document, and the element (its rendered copy, when a hidden one shares the id) fits
 * inside the window. */
async function fitsWidth(page: Page, testId: string): Promise<void> {
  const m = await page.evaluate((id) => {
    const shown = [...document.querySelectorAll(`[data-testid="${id}"]`)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const el = shown[shown.length - 1]!;
    return { doc: document.documentElement.scrollWidth, win: window.innerWidth, left: el.left, right: el.right };
  }, testId);
  expect(m.doc, "document width").toBeLessThanOrEqual(m.win);
  expect(m.left).toBeGreaterThanOrEqual(0);
  expect(m.right).toBeLessThanOrEqual(m.win + 0.5);
}

test.afterEach(async ({ weft }) => {
  // Back to the pinned base world, which every later spec's reset keeps (a reset keeps the world's own profile).
  const r = await weft.post<{ ok: boolean; profile: string }>("/v1/sim/reset", { profile: "base" }, 60_000);
  expect(r.profile).toBe("base");
});

test("GP26: the Agent page lists conversations and background work, threads a follow-up and survives a reload", async ({ page, weft }) => {
  const rich = await weft.post<{ ok: boolean; profile: string }>("/v1/sim/reset", { profile: "rich" }, 60_000);
  expect(rich.profile).toBe("rich");
  const page1 = await weft.get<{ data: Row[] }>("/v1/agent/runs", { trigger: "chat", limit: 100 });
  const seeded = page1.data.filter((r) => r.askedFrom === "agent");
  expect(seeded.length, "Vic has recorded chat runs on the rich world").toBeGreaterThan(0);
  expect(seeded.every((r) => r.threadId !== null && r.question), "every recorded run is a turn of a thread, with its question").toBe(true);
  expect(seeded.every((r) => r.provider === "openai"), "the recorded runs ran on the live model").toBe(true);
  const flagged = seeded.find((r) => r.question === "Which paychecks are flagged in the Oct 30 payroll draft?")!;
  expect(flagged, "the flagged-paychecks conversation").toBeTruthy();
  const flaggedTurns = seeded.filter((r) => r.threadId === flagged.threadId).length;
  const background = await weft.get<{ data: AgentRunRow[] }>("/v1/agent/runs", { trigger: "background", limit: 50 });
  expect(background.data.length).toBeGreaterThan(0);

  await test.step("Agent in the sidebar opens the page with the side panel closed", async () => {
    await openApp(page, "/app");
    const nav = page.getByTestId("nav-agent");
    await expect(nav).toHaveText("Agent");
    await nav.click();
    await expect(page).toHaveURL(/\/app\/agent$/);
    await expect(nav).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId(T.page)).toBeVisible();
    await expect(page.getByTestId(TID.agentComposer), "the side panel is closed on the Agent page").toHaveCount(0);
    await expect(page.getByTestId(T.start)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("New chat");
  });

  await test.step("the recorded conversations show as threads, and the routine runs as background work", async () => {
    const items = page.getByTestId(T.thread);
    await expect(items).toHaveCount(new Set(seeded.map((r) => r.threadId)).size);
    await expect(items.filter({ hasText: "Show payroll cost by month for 2026" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Show payroll cost by month for 2026" })).toContainText("2 turns");
    await page.getByTestId(T.backgroundTab).click();
    const bg = page.getByTestId(T.background);
    await expect(bg.first()).toBeVisible();
    // A routine may start on the frozen clock's first tick after the reset, so compare with a fresh read.
    await expect.poll(async () => (await bg.count()) === (await weft.get<{ data: AgentRunRow[] }>("/v1/agent/runs", { trigger: "background", limit: 50 })).data.length).toBe(true);
    await expect(bg.first()).toHaveAttribute("href", /\/app\/runs\/run_\d+/);
    await expect(bg.first()).not.toContainText(/rtr_|run_\d/);
    await page.getByTestId(T.threadsTab).click();
  });

  await test.step("a recorded conversation opens with every turn, the live model and its cost", async () => {
    await page.getByTestId(T.thread).filter({ hasText: "Which paychecks are flagged" }).click();
    await expect(page).toHaveURL(new RegExp(`\\?thread=${flagged.threadId}$`));
    await expect(page.getByTestId(T.turn)).toHaveCount(flaggedTurns);
    const lena = page.getByTestId(T.turn).filter({ has: page.getByTestId(T.question).filter({ hasText: "Why is Lena Brooks flagged?" }) });
    await expect(lena.getByTestId(TID.agentAnswer)).toContainText("18.0%");
    await expect(page.getByTestId(T.model)).toHaveText("openai gpt-5.6-luna (live)");
    await expect(page.getByTestId(T.cost)).toHaveText(/^\$\d/);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Which paychecks are flagged");
    await expect(page.getByTestId(T.composerNote)).toContainText("A follow-up sees the last three turns");
    await expect(page.getByTestId(T.composer)).toHaveAttribute("placeholder", "Ask a follow-up...");
  });

  let threadId = "";
  await test.step("New chat, then a question on the scripted provider, starts a thread", async () => {
    await page.getByTestId(T.newChat).click();
    await expect(page).toHaveURL(/\/app\/agent$/);
    await page.getByTestId(T.composer).fill("Show payroll cost by month");
    await page.getByTestId(T.send).click();
    await expect(page).toHaveURL(/\?thread=thr_[0-9a-f]{20}$/);
    threadId = new URL(page.url()).searchParams.get("thread")!;
    const turn = page.getByTestId(T.turn).first();
    await expect(turn.getByTestId(T.question)).toHaveText("Show payroll cost by month");
    await expect(turn.getByTestId(TID.agentAnswer)).toContainText("Sep 2026");
    await expect(turn.getByTestId(W3_CHAT_TID.chart)).toBeVisible();
    await expect(page.getByTestId(T.thread).first()).toContainText("Show payroll cost by month");
    await expect(page.getByTestId(T.thread).first()).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Show payroll cost by month");
  });

  await test.step("a follow-up stays in the thread and reads the first turn", async () => {
    await expect(page.getByTestId(T.send)).toBeDisabled();
    await page.getByTestId(T.composer).fill("Why is the NY raise flagged in the Oct 30 payroll?");
    await page.getByTestId(T.send).click();
    await expect(page.getByTestId(T.turn)).toHaveCount(2);
    const second = page.getByTestId(T.turn).nth(1);
    await expect(second.getByTestId(T.question)).toHaveText("Why is the NY raise flagged in the Oct 30 payroll?");
    await expect(second.getByTestId(TID.agentAnswer)).toContainText("gross change");
    await expect(second.getByTestId(TID.agentStatus)).toHaveAttribute("data-status", "done");
    expect(new URL(page.url()).searchParams.get("thread")).toBe(threadId);
    await expect(page.getByTestId(T.thread).first()).toContainText("2 turns");
    const runs = (await weft.get<{ data: Row[] }>("/v1/agent/runs", { thread_id: threadId })).data;
    expect(runs).toHaveLength(2);
    const followUp = runs.find((r) => r.question?.startsWith("Why"))!;
    const trace = await weft.get<{ steps: { kind: string; result: { text?: string } | null }[] }>(`/v1/agent/runs/${followUp.id}/trace`);
    const pack = trace.steps.find((s) => s.kind === "context")?.result?.text ?? "";
    expect(pack).toContain('<earlier_conversation turns="1">');
    expect(pack).toContain("<question>Show payroll cost by month</question>");
  });

  await test.step("the deep link reloads to the same conversation", async () => {
    await page.reload();
    await expect(page.getByTestId(T.turn)).toHaveCount(2);
    await expect(page.getByTestId(T.question).first()).toHaveText("Show payroll cost by month");
    await expect(page.getByTestId(TID.agentComposer)).toHaveCount(0);
    await expect(page.getByTestId(T.composer)).toHaveAttribute("placeholder", "Ask a follow-up...");
  });

  await test.step("the sidebar's New agent thread starts a new chat on this page, not in the side panel", async () => {
    await page.getByTestId(W3_SHELL_TID.newThread).click();
    await expect(page).toHaveURL(/\/app\/agent\/?$/);
    await expect(page.getByTestId(T.turn)).toHaveCount(0);
    await expect(page.getByTestId(T.composer)).toHaveAttribute("placeholder", "Ask the agent...");
    await expect(page.getByTestId(T.composer)).toBeFocused();
    await expect(page.getByTestId(TID.agentComposer)).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId(T.turn)).toHaveCount(2);
  });

  await test.step("1440 by 900: the list column, the conversation and the composer side by side", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const list = await page.getByTestId(T.list).first().boundingBox();
    const composer = await page.getByTestId(T.composer).boundingBox();
    expect(list!.width).toBeGreaterThan(250);
    expect(composer!.x).toBeGreaterThan(list!.x + list!.width);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(900);
    await fitsWidth(page, T.page);
    await expect(page.getByTestId(T.listToggle)).toBeHidden();
  });

  await test.step("390 by 844: the list is a drawer and the conversation fills the width", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId(T.list)).toBeHidden();
    await fitsWidth(page, T.page);
    await fitsWidth(page, T.composer);
    const composer = await page.getByTestId(T.composer).boundingBox();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
    await page.getByTestId(T.listToggle).click();
    const drawer = page.getByTestId(T.list).last();
    await expect(drawer).toBeVisible();
    await fitsWidth(page, T.list);
    await drawer.getByTestId(T.thread).filter({ hasText: "Show payroll cost by month for 2026" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\?thread=thr_[0-9a-f]{20}$/);
    await expect(page.getByTestId(T.turn)).toHaveCount(2);
    await expect(page.getByTestId(T.title)).toHaveText("Show payroll cost by month for 2026");
  });
});
