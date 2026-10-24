// weft-core's HostedExtras over HTTP (design 6.3): the front's forwarded /api/_hosted/* requests, verified by their
// x-weft-ctx. Dictation and spoken answers are model calls, so they take RL_RUN under the visitor's own key, the one
// the slot's agent runs use.
import { describe, expect, it } from "vitest";
import { HOSTED_PATHS, HOSTED_RATE_LIMITS } from "../../src/shared/contracts";
import { extrasFetch, runLimitKey, type ExtrasHttpEnv } from "../../src/extras/http";
import type { HostedExtrasApi } from "../../src/extras/ports";
import { signCtx } from "../../src/shared/tokens";

const CTX = "c".repeat(64);
const VISITOR = "vis_" + "d".repeat(32);

function setup() {
  const dictated: unknown[] = [];
  const keys: string[] = [];
  const seen = new Map<string, number>();
  const env: ExtrasHttpEnv = {
    WEFT_CTX_SECRET: CTX,
    RL_RUN: { limit: async ({ key }) => { keys.push(key); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= HOSTED_RATE_LIMITS.RL_RUN.limit }; } },
  };
  const spoken: { text: string }[] = [];
  const api = {
    dictate: async (input: unknown) => { dictated.push(input); return { ok: true, text: "hello", neurons: 1 }; },
    speak: async (input: { text: string }) => {
      spoken.push(input);
      return input.text.length > 180 ? { ok: false, code: "SPEECH_TOO_LONG", message: "too long" } : input.text === "broke" ? { ok: false, code: "SPEECH_BUDGET", message: "used up" } : { ok: true, audio: new Uint8Array([0xff, 0xfb]), contentType: "audio/mpeg", chars: input.text.length, neurons: 3 };
    },
  } as unknown as HostedExtrasApi;
  return { env, api, dictated, keys, spoken };
}
const speak = async (s: ReturnType<typeof setup>, body: string, visitor: string | null = VISITOR) => extrasFetch(new Request(`https://weft-core.internal${HOSTED_PATHS.speak}`, {
  method: "POST", body,
  headers: { "content-type": "application/json", "x-weft-ctx": await signCtx(CTX, { slot: "slot-1", gen: 2, visitor, ipHash: "h".repeat(32), human: true, smoke: false, iat: Math.floor(Date.now() / 1000) }) },
}), s.api, s.env);
const dictate = async (s: ReturnType<typeof setup>, visitor: string | null = VISITOR, smoke = false) => extrasFetch(new Request(`https://weft-core.internal${HOSTED_PATHS.dictate}`, {
  method: "POST", body: new Uint8Array(64),
  headers: { "content-type": "audio/wav", "x-weft-ctx": await signCtx(CTX, { slot: "slot-1", gen: 2, visitor, ipHash: "h".repeat(32), human: true, smoke, iat: Math.floor(Date.now() / 1000) }) },
}), s.api, s.env);

describe("spoken answers over HTTP", () => {
  it("answers audio/mpeg for a short text, the refusal as JSON otherwise, and RL_RUN per visitor like dictation", async () => {
    const s = setup();
    const ok = await speak(s, JSON.stringify({ text: "Four paychecks need review." }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([0xff, 0xfb]);
    expect(s.spoken[0]).toMatchObject({ text: "Four paychecks need review.", slot: "slot-1", gen: 2, visitor: VISITOR });
    expect((await speak(s, JSON.stringify({ text: "x".repeat(181) }))).status).toBe(413);
    const budget = await speak(s, JSON.stringify({ text: "broke" }));
    expect(budget.status).toBe(429);
    expect(await budget.json()).toMatchObject({ ok: false, code: "SPEECH_BUDGET" });
    expect((await speak(s, "not json")).status).toBe(400);
    expect((await speak(s, JSON.stringify({ text: "y".repeat(3_000) }))).status).toBe(413);
    // RL_RUN: the same key as the slot's agent runs and dictation, so the three share one allowance.
    const statuses: number[] = [];
    for (let i = 0; i < HOSTED_RATE_LIMITS.RL_RUN.limit; i++) statuses.push((await speak(s, JSON.stringify({ text: "Hi." }))).status);
    expect(statuses.at(-1)).toBe(429);
    expect(new Set(s.keys)).toEqual(new Set([`run:${VISITOR}`]));
  });
});

describe("dictation over HTTP", () => {
  it("takes RL_RUN per visitor, as the slot's agent runs do: past the limit it answers 429 without a model call", async () => {
    const s = setup();
    const statuses: number[] = [];
    for (let i = 0; i < HOSTED_RATE_LIMITS.RL_RUN.limit + 1; i++) statuses.push((await dictate(s)).status);
    expect(statuses.slice(0, -1).every((x) => x === 200)).toBe(true);
    const last = await dictate(s);
    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(s.dictated).toHaveLength(HOSTED_RATE_LIMITS.RL_RUN.limit);
    expect(new Set(s.keys)).toEqual(new Set([`run:${VISITOR}`]));
    // Another visitor has its own allowance.
    expect((await dictate(s, "vis_" + "e".repeat(32))).status).toBe(200);
  });

  it("keys the smoke and a visit without a visitor apart from every visitor", () => {
    expect(runLimitKey({ visitor: VISITOR, smoke: false, ipHash: "x" })).toBe(`run:${VISITOR}`);
    expect(runLimitKey({ visitor: null, smoke: true, ipHash: "x" })).toBe("run:smoke");
    expect(runLimitKey({ visitor: null, smoke: false, ipHash: "x" })).toBe("run:ip:x");
  });
});
