// KV weft-config resolution (section 0: every cap from KV, the live cap off, visitor and IP caps follow the day cap),
// the world env the Weft stack reads, and the showcase memo's bounds.
import { describe, expect, it } from "vitest";
import { HOSTED_CAP_DEFAULTS, HOSTED_CONFIG_KEYS } from "../../src/shared/contracts";
import { agentEnabled, capsFrom, CONFIG_KEYS, envConfig, readConfig } from "../../src/shared/config";
import { configEnv, liveEnv } from "../../src/core/company/company-do-env";
import { MEMO_MAX_ENTRY_BYTES, ResponseMemo } from "../../src/front/memo";

const m = (o: Record<string, string>) => new Map<string, string | null>(Object.entries(o));

describe("caps", () => {
  it("defaults to section 0: run 0.10, day 2.00, no live cap, visitor and IP caps equal to the day cap", () => {
    expect(capsFrom(new Map(), {})).toEqual({ ...HOSTED_CAP_DEFAULTS });
    expect(HOSTED_CAP_DEFAULTS).toEqual({ runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 });
  });

  it("reads KV first, then the Worker var, and keeps the visitor and IP caps on the day cap unless set", () => {
    const env = { WEFT_RUN_USD_CAP: "0.10", WEFT_DAY_USD_CAP: "2.00", WEFT_LIVE_USD_CAP: "off", WEFT_NEURON_DAY_CAP: "5000" };
    expect(capsFrom(m({ [HOSTED_CONFIG_KEYS.capDayUsd]: "3.5" }), env)).toEqual({ runUsd: 0.1, dayUsd: 3.5, liveUsd: null, visitorDayUsd: 3.5, ipDayUsd: 3.5, neuronsDay: 5000 });
    expect(capsFrom(m({ [HOSTED_CONFIG_KEYS.capVisitorDayUsd]: "0.25", [HOSTED_CONFIG_KEYS.capIpDayUsd]: "0.5" }), env)).toMatchObject({ visitorDayUsd: 0.25, ipDayUsd: 0.5, dayUsd: 2 });
    expect(capsFrom(m({ [HOSTED_CONFIG_KEYS.capLiveUsd]: "20" }), env).liveUsd).toBe(20);
    expect(capsFrom(m({ [HOSTED_CONFIG_KEYS.capLiveUsd]: "off" }), { WEFT_LIVE_USD_CAP: "0.5" }).liveUsd).toBeNull();
    expect(capsFrom(new Map(), { WEFT_LIVE_USD_CAP: "0.5" }).liveUsd).toBe(0.5);
    expect(capsFrom(m({ [HOSTED_CONFIG_KEYS.capRunUsd]: "nonsense" }), env).runUsd).toBe(0.1);
  });

  it("treats only agent.enabled=false as the kill switch", () => {
    expect(agentEnabled(new Map())).toBe(true);
    expect(agentEnabled(m({ [HOSTED_CONFIG_KEYS.agentEnabled]: "FALSE" }))).toBe(false);
    expect(agentEnabled(m({ [HOSTED_CONFIG_KEYS.agentEnabled]: "true" }))).toBe(true);
  });

  it("memoizes KV reads for a minute and falls back to one read per key", async () => {
    let bulk = 0, single = 0;
    const kv = {
      async get(k: string | string[]) {
        if (Array.isArray(k)) { bulk += 1; throw new Error("no bulk get here"); }
        single += 1;
        return k === HOSTED_CONFIG_KEYS.capDayUsd ? "1.5" : null;
      },
    } as unknown as KVNamespace;
    const a = await readConfig(kv, 1_000);
    expect(a.get(HOSTED_CONFIG_KEYS.capDayUsd)).toBe("1.5");
    expect(single).toBe(CONFIG_KEYS.length);
    await readConfig(kv, 50_000);
    expect(bulk).toBe(1);
    await readConfig(kv, 70_000);
    expect(bulk).toBe(2);
  });
});

describe("a failing KV", () => {
  const failing = (state: { down: boolean; reads: number }) => ({
    async get(k: string | string[]) {
      state.reads += 1;
      if (state.down) throw new Error("KV unavailable");
      return Array.isArray(k) ? new Map(k.map((x) => [x, x === HOSTED_CONFIG_KEYS.capDayUsd ? "1.5" : null])) : null;
    },
  }) as unknown as KVNamespace;

  it("pauses the agent on a cold isolate (no values to keep) instead of failing open, and reads KV again next time", async () => {
    const state = { down: true, reads: 0 };
    const kv = failing(state);
    const cold = await readConfig(kv, 1_000);
    expect(agentEnabled(cold)).toBe(false);
    expect(cold.get(HOSTED_CONFIG_KEYS.capDayUsd) ?? null).toBeNull();
    const reads = state.reads;
    await readConfig(kv, 1_001);
    expect(state.reads).toBeGreaterThan(reads);   // the failure is not memoized
    state.down = false;
    const back = await readConfig(kv, 1_002);
    expect(agentEnabled(back)).toBe(true);
    expect(back.get(HOSTED_CONFIG_KEYS.capDayUsd)).toBe("1.5");
  });

  it("pauses the agent when the Worker has no KV binding at all", async () => {
    const none = await readConfig(undefined, 1_000);
    expect(agentEnabled(none)).toBe(false);
    expect(none.get(HOSTED_CONFIG_KEYS.capDayUsd) ?? null).toBeNull();
    expect(agentEnabled(await envConfig({}, 1_000))).toBe(false);
  });

  it("keeps the last values it read when KV fails later", async () => {
    const state = { down: false, reads: 0 };
    const kv = failing(state);
    expect((await readConfig(kv, 1_000)).get(HOSTED_CONFIG_KEYS.capDayUsd)).toBe("1.5");
    state.down = true;
    const stale = await readConfig(kv, 100_000);
    expect(stale.get(HOSTED_CONFIG_KEYS.capDayUsd)).toBe("1.5");
    expect(agentEnabled(stale)).toBe(true);
  });
});

describe("world env", () => {
  it("folds KV values in under the names the Weft stack reads, and forces scripted on slot-smoke", () => {
    const values = m({ [HOSTED_CONFIG_KEYS.agentEnabled]: "false", [HOSTED_CONFIG_KEYS.modelProvider]: "workers_ai", [HOSTED_CONFIG_KEYS.recallSemantic]: "on", [HOSTED_CONFIG_KEYS.capDayUsd]: "3" });
    expect(configEnv(values, "slot")).toEqual({ WEFT_AGENT_ENABLED: "false", WEFT_HOSTED_PROVIDER: "workers_ai", WEFT_SEMANTIC_RECALL: "1", WEFT_DAY_USD_CAP: "3" });
    expect(configEnv(new Map(), "smoke")).toEqual({ WEFT_LLM: "scripted", WEFT_HOSTED_PROVIDER: "scripted" });
  });

  it("is a live, read-only view: later KV values show through, writes do not", () => {
    let over: Record<string, string> = {};
    const env = liveEnv({ WEFT_LLM: "openai", A: "1" }, () => over);
    expect(env.WEFT_LLM).toBe("openai");
    over = { WEFT_LLM: "scripted" };
    expect(env.WEFT_LLM).toBe("scripted");
    expect(Object.keys(env).sort()).toEqual(["A", "WEFT_LLM"]);
    expect("A" in env).toBe(true);
    expect(() => { (env as Record<string, string>).A = "2"; }).toThrow();
    expect(env.A).toBe("1");
  });
});

describe("showcase memo", () => {
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });

  it("keys by snapshot, principal, path and query, and serves hits without the world", async () => {
    const memo = new ResponseMemo();
    const k = ResponseMemo.key({ path: "/v1/workers", search: "?page=1", principal: "usr_dana", snapshot: "s1" });
    expect(k).toBe("s1|usr_dana|/v1/workers?page=1");
    const first = await memo.put(k, ok('{"a":1}', { etag: 'W/"1.x"' }));
    expect(first.headers.get("x-weft-memo")).toBe("miss");
    expect(await first.text()).toBe('{"a":1}');
    const hit = memo.get(k)!;
    expect(hit.headers.get("x-weft-memo")).toBe("hit");
    expect(hit.headers.get("etag")).toBe('W/"1.x"');
    expect(await hit.text()).toBe('{"a":1}');
    expect(memo.get(ResponseMemo.key({ path: "/v1/workers", search: "?page=1", principal: "usr_dana", snapshot: "s2" }))).toBeNull();
  });

  it("keeps no stream, no no-store response and no error, and stays under its byte bound", async () => {
    const memo = new ResponseMemo(1000, 400);
    await memo.put("sse", new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } }));
    await memo.put("ns", ok("{}", { "cache-control": "no-store" }));
    await memo.put("err", new Response("{}", { status: 404 }));
    expect(memo.size.entries).toBe(0);
    for (let i = 0; i < 5; i++) await memo.put(`k${i}`, ok("x".repeat(300)));
    expect(memo.size.bytes).toBeLessThanOrEqual(1000);
    expect(memo.get("k0")).toBeNull();
    expect(memo.get("k4")).not.toBeNull();
    await memo.put("big", ok("y".repeat(401)));
    expect(memo.get("big")).toBeNull();
    expect(MEMO_MAX_ENTRY_BYTES).toBe(512 * 1024);
  });
});
