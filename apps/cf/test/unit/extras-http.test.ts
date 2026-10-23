// weft-core's HostedExtras over HTTP (design 6.3): the front's forwarded /api/_hosted/* requests, verified by their
// x-weft-ctx. Dictation is a model call, so it takes RL_RUN under the visitor's own key, the one the slot's agent
// runs use.
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
  const api = { dictate: async (input: unknown) => { dictated.push(input); return { ok: true, text: "hello", neurons: 1 }; } } as unknown as HostedExtrasApi;
  return { env, api, dictated, keys };
}
const dictate = async (s: ReturnType<typeof setup>, visitor: string | null = VISITOR, smoke = false) => extrasFetch(new Request(`https://weft-core.internal${HOSTED_PATHS.dictate}`, {
  method: "POST", body: new Uint8Array(64),
  headers: { "content-type": "audio/wav", "x-weft-ctx": await signCtx(CTX, { slot: "slot-1", gen: 2, visitor, ipHash: "h".repeat(32), human: true, smoke, iat: Math.floor(Date.now() / 1000) }) },
}), s.api, s.env);

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
