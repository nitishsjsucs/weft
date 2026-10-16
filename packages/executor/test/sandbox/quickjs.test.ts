// The QuickJS engine on its own (harness 3.5 and 3.6): limits, error codes, the weft.call RPC, taint OR, logs.
import { describe, expect, it } from "vitest";
import { DEFAULT_CODE_LIMITS, type CodeRunInput } from "@weft/contracts";
import { createQuickJsEngine } from "../../src/sandbox/quickjs";

const engine = createQuickJsEngine();
const run = (source: string, call: (name: string, args: unknown) => Promise<unknown> = async () => ({ ok: true, status: "done", data: null, tainted: false }), limits = DEFAULT_CODE_LIMITS, inputs: unknown = null) =>
  engine.run({ language: "js", source, purpose: "test", inputs } satisfies CodeRunInput, limits, call);

describe("quickjs engine", () => {
  it("runs a script and returns its value; the box has no fetch, require, process or timers", async () => {
    const r = await run("return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.__weft_call, 1 + 2, inputs.n];", undefined, DEFAULT_CODE_LIMITS, { n: 7 });
    expect(r).toMatchObject({ ok: true, error: null, value: ["undefined", "undefined", "undefined", "undefined", "undefined", 3, 7], tainted: false, calls: [] });
  });

  it("acceptance: an infinite loop gives SANDBOX_TIMEOUT within the CPU deadline", async () => {
    const t0 = Date.now();
    const r = await run("while (true) {}", undefined, { ...DEFAULT_CODE_LIMITS, cpuMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SANDBOX_TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("acceptance: a heap bomb gives SANDBOX_OOM under the 32 MiB heap", async () => {
    const t0 = Date.now();
    const r = await run("const keep = []; for (;;) keep.push(new Uint8Array(1 << 20));");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SANDBOX_OOM");
    expect(r.error?.message).toMatch(/out of memory/);
    // Allocating 64 MiB at once (harness 3.6).
    expect((await run("const b = new ArrayBuffer(64 * 1024 * 1024); return b.byteLength;")).error?.code).toBe("SANDBOX_OOM");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("deep recursion is stopped by the stack limit", async () => {
    const r = await run("const f = (n) => f(n + 1) + 1; return f(0);");
    expect(r.error?.code).toBe("SANDBOX_OOM");
  });

  it("weft.call is an async RPC: args and results cross as JSON, calls are recorded, taint is the OR", async () => {
    const seen: [string, unknown][] = [];
    const call = async (name: string, args: unknown) => {
      seen.push([name, args]);
      return name === "notices__get" ? { ok: true, status: "done", data: { body: "<untrusted>x</untrusted>" }, tainted: true } : { ok: true, status: "done", data: { n: 2 }, tainted: false };
    };
    const r = await run("const a = await weft.call('people__search', { q: 'Ada' }); const b = await weft.call('notices__get', { notice_id: 'ntc_0001' }); console.log('n', a.data.n); return { n: a.data.n, tainted: b.tainted };", call);
    expect(r).toMatchObject({ ok: true, value: { n: 2, tainted: true }, tainted: true, logs: "n 2" });
    expect(seen).toEqual([["people__search", { q: "Ada" }], ["notices__get", { notice_id: "ntc_0001" }]]);
    expect(r.calls.map((c) => [c.command, c.outcome])).toEqual([["people__search", "done"], ["notices__get", "done"]]);
  });

  it("parallel weft.call promises are served one at a time, in order", async () => {
    let active = 0, maxActive = 0;
    const call = async (name: string) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; return { ok: true, status: "done", data: name, tainted: false }; };
    const r = await run("const rs = await Promise.all([1, 2, 3].map((i) => weft.call('people__get_' + i, {}))); return rs.map((x) => x.data);", call);
    expect(r.value).toEqual(["people__get_1", "people__get_2", "people__get_3"]);
    expect(maxActive).toBe(1);
  });

  it("acceptance: the 26th call is refused as data and the run ends CALL_BUDGET", async () => {
    let n = 0;
    const r = await run("const out = []; for (let i = 0; i < 26; i++) out.push(await weft.call('people__search', { q: String(i) })); return out[25];", async () => { n++; return { ok: true, status: "done", data: null, tainted: false }; });
    expect(n).toBe(25);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CALL_BUDGET");
    expect(r.calls).toHaveLength(26);
    expect(r.calls[25]).toMatchObject({ outcome: "refused:CALL_BUDGET" });
  });

  it("a script that keeps calling past the budget is stopped and its calls list stays bounded", async () => {
    const r = await run("for (;;) await weft.call('x', {});", async () => ({ ok: true, status: "done", data: null, tainted: false }), { ...DEFAULT_CODE_LIMITS, cpuMs: 300 });
    expect(r.ok).toBe(false);
    expect(["SANDBOX_TIMEOUT", "CALL_BUDGET"]).toContain(r.error?.code);
    expect(r.calls).toHaveLength(26);
  });

  it("inner results over the byte budget are refused as data", async () => {
    const r = await run("const a = await weft.call('x', {}); return a.ok;", async () => ({ ok: true, status: "done", data: "y".repeat(2_000), tainted: false }), { ...DEFAULT_CODE_LIMITS, maxCallBytes: 1_000 });
    expect(r.error?.code).toBe("CALL_BUDGET");
  });

  it("a thrown error, a non-JSON value, an oversized value and a dangling promise are SANDBOX_ERROR", async () => {
    expect((await run("throw new Error('nope')")).error).toEqual({ code: "SANDBOX_ERROR", message: "Error: nope" });
    expect((await run("syntax error here")).error?.code).toBe("SANDBOX_ERROR");
    expect((await run("const o = {}; o.o = o; return o;")).error?.code).toBe("SANDBOX_ERROR");
    expect((await run("return 'z'.repeat(70000);")).error?.message).toMatch(/over the 65536 byte cap/);
    expect((await run("await new Promise(() => {}); return 1;")).error?.message).toMatch(/nothing resolves/);
  });

  it("logs are captured and capped; a host call that hangs hits the wall deadline", async () => {
    const r = await run("for (let i = 0; i < 2000; i++) console.log('line', i, { i }); return 1;");
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(r.logs)).toBeLessThanOrEqual(DEFAULT_CODE_LIMITS.maxLogBytes + 64);
    expect(r.logs).toMatch(/logs cut at 8192 bytes/);
    const slow = await run("await weft.call('x', {}); return 1;", () => new Promise((ok) => setTimeout(() => ok({ ok: true }), 600)), { ...DEFAULT_CODE_LIMITS, wallMs: 150 });
    expect(slow.error?.code).toBe("SANDBOX_TIMEOUT");
  });

  it("host time does not count against the CPU deadline", async () => {
    const r = await run("for (let i = 0; i < 4; i++) await weft.call('x', {}); return 'ok';", () => new Promise((ok) => setTimeout(() => ok({ ok: true, status: "done" }), 120)), { ...DEFAULT_CODE_LIMITS, cpuMs: 200 });
    expect(r).toMatchObject({ ok: true, value: "ok" });
  });
});
