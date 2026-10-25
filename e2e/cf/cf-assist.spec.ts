// The cursor assistant on the hosted stack (SPEC 9.12; docs/cloudflare/design.md 5.4 and 9.5): the same assistant in
// the static export, on the operator lease's pool slot with the scripted provider. A question goes through the front
// Worker's gates as an assist run (POST /api/v1/agent/runs); the instant resolver needs no model; navigate and show
// land on the export's section shells (trailing slashes); without live speech recognition the hosted app offers the
// recorded clip and its dictation route instead (a refused microphone is said plainly); the speak route answers through
// the gate with audio; and, as the export ships the fixed voice file, the CSP lets the in-browser voice download from
// Hugging Face and compile its WebAssembly, and nothing more. Nothing here approves or submits anything.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mutationHeadroom } from "./world";
import { ASSIST_TID as A } from "../../packages/contracts/src/ext/assist";

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

async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(A.popover)).toHaveCount(0);
}

test("the cursor assistant on a leased hosted world: resolver, go there, show, voice fallback and speech", async ({ page, operator }) => {
  test.setTimeout(240_000);
  // Each question is one mutation (the run); the speak checks are three more.
  await mutationHeadroom(8);
  // Live speech recognition is absent here, so the hosted app falls back to a recorded clip (the dictation route).
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  const res = await page.goto("/app/");
  expect(res?.status()).toBe(200);
  const csp = res?.headers()["content-security-policy"] ?? "";
  // The export ships the fixed voice file (apps/web/scripts/cf-export.ts VOICE_FILE), so the policy adds exactly the
  // voice model's download hosts to connect-src and 'wasm-unsafe-eval' to script-src, and no string eval.
  const connect = /connect-src ([^;]*)/.exec(csp)?.[1]?.split(" ") ?? [];
  expect(connect[0], "connect-src starts with self").toBe("'self'");
  expect(connect.filter((s) => /huggingface|hf\.co/.test(s)), "the voice model hosts").toEqual(["https://huggingface.co", "https://*.hf.co"]);
  expect(connect.filter((s) => s !== "'self'" && !/^wss?:/.test(s) && !/huggingface|hf\.co/.test(s)), "no other host").toEqual([]);
  expect(csp, "WebAssembly compiles for the voice").toMatch(/script-src [^;]*'wasm-unsafe-eval'/);
  expect(csp, "no string eval").not.toMatch(/'unsafe-eval'/);
  await expect(page.getByTestId("hosted-world")).toHaveAttribute("data-slot", operator.lease.slot);

  await test.step("a where question takes the instant path: no model, it opens the audit log", async () => {
    await ask(page, "Where is the audit log?");
    await expect(page).toHaveURL(/\/app\/audit\/?$/);
    await expect(page.getByTestId(A.answer)).toContainText("audit log");
    // Read back: the run the question started was answered by the resolver, at no cost (no model call).
    const origin = new URL(page.url()).origin;
    const runs = await operator.context.request.get("/api/v1/agent/runs?trigger=chat&limit=10", { headers: { origin, "x-weft-principal": "usr_dana" } });
    expect(runs.status()).toBe(200);
    const row = ((await runs.json()) as { data: { question: string | null; model: string; costUsdMicros: number }[] }).data.find((r) => r.question === "Where is the audit log?");
    expect(row, "the question's run").toMatchObject({ model: "resolver", costUsdMicros: 0 });
    await dismiss(page);
  });

  await test.step("go there: the Oct 30 draft with Needs review ringed", async () => {
    await ask(page, "Show me the Oct 30 payroll flags");
    await expect(page).toHaveURL(/\/app\/payroll\/pay_2026_10_30\/?/);
    await expect(page.getByTestId(A.bubble)).toHaveText("Needs review");
    await expect(page.locator("[data-tour-ring]").last()).toBeVisible();
    await dismiss(page);
  });

  await test.step("show: from Home, Lena's paycheck opens in its drawer through the validated deep link", async () => {
    await page.goto("/app/");
    await ask(page, "Show me Lena's paycheck on the Oct 30 run");
    await expect(page).toHaveURL(/\/app\/payroll\/pay_2026_10_30\/?\?paycheck=wrk_0026$/);
    await expect(page.getByTestId("paycheck-drawer")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Lena Brooks" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  await test.step("voice in: the microphone is offered as a recorded clip, and a refused microphone is said plainly", async () => {
    // The browser refuses the microphone (as a person who clicks Block): the composer says so in plain words.
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) });
    });
    await page.keyboard.press("ControlOrMeta+KeyJ");
    const mic = page.getByTestId(A.mic);
    await expect(mic).toBeVisible();
    // No live recognition here, so the hosted app records a clip for its dictation route.
    await expect(mic).toHaveAttribute("data-mode", "record");
    await mic.click();
    await expect(page.getByTestId(A.composer)).toContainText("The browser did not allow the microphone. Type your question, or allow the microphone and try again.");
    await page.keyboard.press("Escape");
  });

  await test.step("speak: Aura-2 through the gate answers with audio; an empty or a long text is refused", async () => {
    const origin = new URL(page.url()).origin;
    const say = (text: string) => operator.context.request.post("/api/_hosted/speak", { data: { text }, headers: { origin, "x-weft-principal": "usr_dana" } });
    const ok = await say("Four paychecks need review on this draft.");
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toContain("audio/mpeg");
    expect((await ok.body()).length).toBeGreaterThan(0);
    const empty = await say("   ");
    expect(empty.status()).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe("SPEECH_EMPTY");
    const long = await say("word ".repeat(60));
    expect(long.status()).toBe(413);
    expect(((await long.json()) as { code: string }).code).toBe("SPEECH_TOO_LONG");
  });
});
