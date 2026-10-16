// code.run through the real executor (harness 3.4 and 3.6): weft.call routes read commands through the pipeline
// with the run handle, writes and proposals are SANDBOX_NOT_ALLOWED, taint is the OR of the inner calls and a
// tainted result is wrapped with the run nonce, limits come back as refusals, and WEFT_SANDBOX=off refuses.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle, ToolOutcome } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { createSandbox } from "../../src/index";
import { nonceFromToken } from "../../src/untrusted";
import { count, fixtureCommands, makeWorld, type World } from "../fixtures";

// The fixture reads are sandbox "hidden"; the real read commands mark themselves "read". Two of them do here.
const commands: WeftCommand[] = fixtureCommands.map((c) => (c.name === "people.search" || c.name === "notices.get" ? { ...c, sandbox: "read" as const } : c));
const ALLOW = ["code.run", "people.search", "notices.get", "comms.send_message", "actions.list"];

const prior = process.env.WEFT_SANDBOX;
beforeAll(() => { process.env.WEFT_SANDBOX = "quickjs"; });
afterAll(() => { if (prior === undefined) delete process.env.WEFT_SANDBOX; else process.env.WEFT_SANDBOX = prior; });

type Data = { ok: boolean; value: unknown; error: { code: string; message: string } | null; logs: string; calls: { command: string; outcome: string }[]; memory_at: string };
const dataOf = (o: ToolOutcome) => (o.ok && o.status === "done" ? (o.data as Data) : null);

describe("code.run", () => {
  let w: World;
  let h: RunHandle;
  let n = 0;
  const exec = (source: string, extra: Record<string, unknown> = {}) => w.executor.agent.exec(h, { callId: `c${++n}`, command: "code__run", args: { purpose: "test", source, ...extra } });
  beforeEach(async () => {
    w = await makeWorld({ commands });
    h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui", allowlist: ALLOW });
  });
  afterEach(async () => { await w.close(); });

  it("acceptance: weft.call routes read commands through the executor; the run stays clean and no action row is written", async () => {
    const actionsBefore = await count(w.db, "actions");
    const o = await exec("const r = await weft.call('people__search', {}); const one = await weft.call('people.search', { query: inputs.q }); return { all: r.data.people.length, hits: one.data.people.length, ok: r.ok };", { inputs_json: JSON.stringify({ q: "zzz-nobody" }) });
    expect(o).toMatchObject({ ok: true, status: "done", tainted: false });
    const d = dataOf(o)!;
    expect(d.ok).toBe(true);
    expect((d.value as { all: number }).all).toBeGreaterThan(0);
    expect(d.value).toMatchObject({ hits: 0, ok: true });
    expect(d.calls.map((c) => [c.command, c.outcome])).toEqual([["people__search", "done"], ["people.search", "done"]]);
    expect(await count(w.db, "actions")).toBe(actionsBefore);
    expect((await w.executor.agent.runState(h)).tainted).toBe(false);
  });

  it("acceptance: a write command gives SANDBOX_NOT_ALLOWED as data and creates no proposal", async () => {
    const o = await exec("const r = await weft.call('comms__send_message', { channel: '#general', text: 'hi' }); return r;");
    const d = dataOf(o)!;
    expect(d.value).toMatchObject({ ok: false, refusal: { code: "SANDBOX_NOT_ALLOWED" } });
    expect(d.calls[0]).toMatchObject({ command: "comms__send_message", outcome: "refused:SANDBOX_NOT_ALLOWED" });
    expect(await count(w.db, "proposals")).toBe(0);
    expect(await count(w.db, "sim_chat_messages", "inbound = 0")).toBe(0);
  });

  it("the run's allowlist and the registry still apply inside the box; code.run cannot nest", async () => {
    const d = dataOf(await exec("return [await weft.call('payroll__preview_run', { run_id: 'pay_2026_10_30' }), await weft.call('nope__nothing', {}), await weft.call('code__run', { purpose: 'x', source: 'return 1' })].map((r) => r.refusal.code);"))!;
    // payroll.preview_run is a draft, so the sandbox field refuses it first; unknown names and code.run itself too.
    expect(d.value).toEqual(["SANDBOX_NOT_ALLOWED", "UNKNOWN_COMMAND", "SANDBOX_NOT_ALLOWED"]);
    const off = await makeWorld({ commands });
    try {
      const narrow = await off.executor.runs.openChatRun(off.ui("usr_dana"), { threadId: null, surface: "human_ui", allowlist: ["code.run", "notices.get"] });
      const o = await off.executor.agent.exec(narrow, { callId: "x", command: "code.run", args: { purpose: "p", source: "return (await weft.call('people__search', {})).refusal.code;" } });
      expect(dataOf(o)!.value).toBe("UNAVAILABLE");
    } finally { await off.close(); }
  });

  it("acceptance: taint is the OR of the inner calls; the result is wrapped with the run nonce and the run is tainted", async () => {
    const o = await exec("const a = await weft.call('people__search', {}); const n = await weft.call('notices__get', { notice_id: 'ntc_0001', response_format: 'detailed' }); return { people: a.data.people.length, body: n.data.notice.body };");
    expect(o).toMatchObject({ ok: true, status: "done", tainted: true });
    const d = dataOf(o)!;
    expect(typeof d.value).toBe("string");
    expect(d.value as string).toMatch(new RegExp(`^<untrusted n="${nonceFromToken(h.token)}" source="sandbox:code.run">`));
    // The injected closing tag inside the notice cannot close either wrapper.
    expect((d.value as string).match(/<\/untrusted>/g)).toHaveLength(1);
    expect(d.calls.map((c) => c.outcome)).toEqual(["done", "done"]);
    const state = await w.executor.agent.runState(h);
    expect(state.tainted).toBe(true);
    // After the box, a send from the same run is a proposal, as for any tainted run.
    const send = await w.executor.agent.exec(h, { callId: "send", command: "comms.send_message", args: { channel: "#payroll", text: "done" } });
    expect(send).toMatchObject({ ok: true, status: "pending_approval" });
  });

  it("acceptance: limits come back as refusals: SANDBOX_TIMEOUT, SANDBOX_OOM, CALL_BUDGET; a script error is data", async () => {
    expect(await exec("while (true) {}")).toMatchObject({ ok: false, refusal: { code: "SANDBOX_TIMEOUT" } });
    expect(await exec("const keep = []; for (;;) keep.push(new Uint8Array(1 << 20));")).toMatchObject({ ok: false, refusal: { code: "SANDBOX_OOM" } });
    expect(await exec("for (let i = 0; i < 26; i++) await weft.call('actions__list', { limit: 1 }); return 1;")).toMatchObject({ ok: false, refusal: { code: "CALL_BUDGET" } });
    const err = await exec("throw new Error('bad math');");
    expect(dataOf(err)).toMatchObject({ ok: false, value: null, error: { code: "SANDBOX_ERROR", message: "Error: bad math" } });
  });

  it("people and API keys cannot run it (no agent run); WEFT_SANDBOX=off refuses with the reason", async () => {
    const human = await w.executor.human.exec(w.ui("usr_dana"), "code.run", { purpose: "p", source: "return 1" });
    expect(human).toMatchObject({ ok: false, refusal: { code: "NOT_PERMITTED" } });
    process.env.WEFT_SANDBOX = "off";
    try {
      expect(await exec("return 1")).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE", message: expect.stringMatching(/WEFT_SANDBOX=off/) } });
      expect(() => createSandbox({})).toThrow(/WEFT_SANDBOX=off/);
      expect(() => createSandbox({ WEFT_SANDBOX: "microvm" })).toThrow(/not built/);
      expect(createSandbox({ WEFT_SANDBOX: "quickjs" }).id).toBe("quickjs");
    } finally { process.env.WEFT_SANDBOX = "quickjs"; }
  });
});
