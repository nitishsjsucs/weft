import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor, RunHandle, ToolOutcome } from "@weft/contracts";
import { count, INJECTION, makeWorld, type World } from "./fixtures";
import { LT_ESCAPE, nonceFromToken, type WeftRunHandle } from "../src/index";

let w: World;
let h: RunHandle;
beforeEach(async () => {
  w = await makeWorld();
  h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await w.close(); });

const ok = (o: ToolOutcome) => { if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o)); return o; };
const code = (o: ToolOutcome) => (o.ok ? null : o.refusal.code);

describe("run handles and derived context", () => {
  it("mints run ids with an opaque handle whose token is stored only as a hash", async () => {
    expect(h.runId).toMatch(/^run_\d{4}$/);
    expect((h as WeftRunHandle).nonce).toBe(nonceFromToken(h.token));
    const [row] = await w.db.all<{ token_hash: string; principal_id: string; on_behalf_of: string }>(`SELECT token_hash, principal_id, on_behalf_of FROM exec_runs` as never);
    expect(row!.token_hash).not.toContain(h.token);
    expect(row!.principal_id).toBe("agt_weft");
    expect(row!.on_behalf_of).toBe("usr_dana");
  });

  it("a forged handle is refused and a forged principal cannot be expressed", async () => {
    const agent: AgentExecutor = w.executor.agent;
    const forged = { runId: h.runId, token: "0".repeat(48) };
    expect(code(await agent.exec(forged, { callId: "c1", command: "people.search", args: {} }))).toBe("NOT_PERMITTED");
    // @ts-expect-error AgentCall has no principal field: a call naming a human principal cannot be expressed.
    const o = await agent.exec(h, { callId: "c2", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" }, principal: "usr_dana", approvedProposalId: "prp_0001" });
    expect(o.ok && o.status).toBe("pending_approval");
    expect(await count(w.db, "actions")).toBe(0);
  });

  it("dedupes on (run_id, call_id)", async () => {
    const a = await w.executor.agent.exec(h, { callId: "same", command: "comms.send_message", args: { channel: "#people-ops", text: "hello" } });
    const b = await w.executor.agent.exec(h, { callId: "same", command: "comms.send_message", args: { channel: "#people-ops", text: "hello" } });
    expect(b).toEqual(a);
    expect(await count(w.db, "sim_chat_messages")).toBe(1);
  });
});

describe("pipeline checks", () => {
  it("UNKNOWN_COMMAND, UNAVAILABLE, INVALID_INPUT with at most 5 issues, null mapping", async () => {
    expect(code(await w.executor.agent.exec(h, { callId: "1", command: "nope.nope", args: {} }))).toBe("UNKNOWN_COMMAND");
    expect(code(await w.executor.agent.exec(h, { callId: "2", command: "routines.enable", args: { routine_id: "rt_0001" } }))).toBe("UNAVAILABLE");
    expect(code(await w.executor.agent.exec(h, { callId: "3", command: "payroll__mark_processed", args: { run_id: "pay_2026_10_30" } }))).toBe("UNAVAILABLE");
    const bad = await w.executor.agent.exec(h, { callId: "4", command: "tax__update_rate", args: { rate_id: 5, rate: "x" } });
    expect(code(bad)).toBe("INVALID_INPUT");
    ok(await w.executor.agent.exec(h, { callId: "5", command: "people__search", args: { query: null, response_format: null } }));
  });

  it("UNKNOWN_REFERENCE names up to 3 closest ids in the company", async () => {
    const o = await w.executor.agent.exec(h, { callId: "1", command: "notices.get", args: { notice_id: "ntc_0002" } });
    expect(code(o)).toBe("UNKNOWN_REFERENCE");
    expect(!o.ok && o.refusal.hint).toContain("ntc_0001");
  });

  it("grant intersection: Theo's chat run cannot write people data", async () => {
    const th = await w.executor.runs.openChatRun(w.ui("usr_theo"), { threadId: null, surface: "human_ui" });
    expect(code(await w.executor.agent.exec(th, { callId: "1", command: "people.set_pay_rate", args: { worker_id: "wrk_0001", amount_cents: 1 } }))).toBe("NOT_PERMITTED");
  });

  it("an untainted main agent send is auto-allowed and lands in one action row", async () => {
    const o = ok(await w.executor.agent.exec(h, { callId: "1", command: "comms__send_message", args: { channel: "#people-ops", text: "Payroll draft is ready." } }));
    expect(o.actionSeq).toBe(1);
    expect(o.tainted).toBe(false);
  });
});

describe("taint and the untrusted wrapper (S7 core)", () => {
  it("one batch [notices__get, comms__send_message] turns the send into a proposal with the banner reason", async () => {
    const read = ok(await w.executor.agent.exec(h, { callId: "c1", command: "notices__get", args: { notice_id: "ntc_0001", response_format: "detailed" }, batch: 1 } as never));
    expect(read.tainted).toBe(true);
    const nonce = nonceFromToken(h.token);
    const body = (read.data as { notice: { body: string } }).notice.body;
    expect(body.startsWith(`<untrusted n="${nonce}" source="notice:ntc_0001">`)).toBe(true);
    expect(body).toContain(`${LT_ESCAPE}/untrusted>`);
    expect(body).toContain(`${LT_ESCAPE}weft_notice>`);
    expect(body.match(/<\/untrusted>/g)).toHaveLength(1);
    expect(body).toContain(INJECTION.slice(0, 20));
    const send = await w.executor.agent.exec(h, { callId: "c2", command: "comms__send_message", args: { channel: "#general", text: "bank details" }, batch: 1 } as never);
    expect(send.ok && send.status).toBe("pending_approval");
    expect(send.tainted).toBe(true);
    const [p] = await w.db.all<{ tainted_by: string; headline: string; content_json: string }>(`SELECT tainted_by, headline, content_json FROM proposals` as never);
    expect(p!.tainted_by).toBe("notice:ntc_0001");
    expect(p!.headline).toBe("Send a message to #general");
    expect(JSON.parse(p!.content_json)).toEqual([{ label: "Message", text: "bank details" }]);
    expect(await count(w.db, "actions")).toBe(0);
    expect(await w.executor.agent.runState(h)).toMatchObject({ tainted: true, taintedBy: "notice:ntc_0001" });
  });

  it("TAINTED_WRITE for routines.draft in a tainted run", async () => {
    ok(await w.executor.agent.exec(h, { callId: "c1", command: "notices.get", args: { notice_id: "ntc_0001", response_format: "detailed" } }));
    expect(code(await w.executor.agent.exec(h, { callId: "c2", command: "routines.draft", args: { name: "x", cron: "0 9 * * 5" } }))).toBe("TAINTED_WRITE");
  });

  it("every MCP-surface run starts tainted", async () => {
    const m = await w.executor.runs.openChatRun({ ...w.ui("usr_dana"), via: "api_key", keyScope: "mcp" }, { threadId: null, surface: "mcp" });
    expect(await w.executor.agent.runState(m)).toMatchObject({ tainted: true, taintedBy: "mcp" });
  });
});

describe("batch rules", () => {
  it("after a refused write, later writes get SKIPPED_AFTER_BLOCK; reads still run", async () => {
    expect(code(await w.executor.agent.exec(h, { callId: "1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "bad" }, batch: "t1" } as never))).toBe("INVALID_INPUT");
    expect(code(await w.executor.agent.exec(h, { callId: "2", command: "comms.send_message", args: { channel: "#general", text: "x" }, batch: "t1" } as never))).toBe("SKIPPED_AFTER_BLOCK");
    ok(await w.executor.agent.exec(h, { callId: "3", command: "people.search", args: {}, batch: "t1" } as never));
    // a new batch resets the state
    ok(await w.executor.agent.exec(h, { callId: "4", command: "comms.send_message", args: { channel: "#general", text: "x" }, batch: "t2" } as never));
  });

  it("after a pending call: skip gives SKIPPED_AFTER_PENDING, propose turns a send into a proposal", async () => {
    const p = await w.executor.agent.exec(h, { callId: "1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" }, batch: 9 } as never);
    expect(p.ok && p.status).toBe("pending_approval");
    expect(code(await w.executor.agent.exec(h, { callId: "2", command: "payroll.preview_run", args: { run_id: "pay_2026_10_30" }, batch: 9 } as never))).toBe("SKIPPED_AFTER_PENDING");
    const s = await w.executor.agent.exec(h, { callId: "3", command: "comms.send_message", args: { channel: "#payroll", text: "rate updated" }, batch: 9 } as never);
    expect(s.ok && s.status).toBe("pending_approval");
  });

  it("a run minted with a reused id after a world reset starts with a fresh batch", async () => {
    // POST /v1/sim/reset rebuilds the tables in this process, so run ids and step numbers start over. GP3's run_0001
    // left a pending batch at step 2; GP4's digest, minted as run_0001 again, had its post turned into a proposal.
    expect((await w.executor.agent.exec(h, { callId: "1", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" }, batch: "step:2" } as never)).ok).toBe(true);
    for (const t of ["exec_calls", "run_taint", "exec_runs"]) await w.db.run(sql.raw(`DELETE FROM ${t}`));
    await w.db.run(sql`DELETE FROM id_counters WHERE prefix = 'run_'`);
    const again = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    expect(again.runId).toBe(h.runId);
    ok(await w.executor.agent.exec(again, { callId: "1", command: "comms.send_message", args: { channel: "#people-ops", text: "digest" }, batch: "step:2" } as never));
  });
});

describe("ceilings and R4", () => {
  it("over the per-call ceiling is refused and cannot be proposed", async () => {
    await w.db.run(`UPDATE limits SET cents = 100 WHERE key = 'agent.payroll_run_cents'` as never);
    expect(code(await w.executor.agent.exec(h, { callId: "1", command: "payroll.submit_run", args: { run_id: "pay_2026_10_30" } }))).toBe("OVER_CEILING");
    expect(await count(w.db, "proposals")).toBe(0);
  });

  it("the _day aggregate counts pending proposals", async () => {
    for (const id of ["wrk_0001", "wrk_0002", "wrk_0003"]) {
      const o = await w.executor.agent.exec(h, { callId: id, command: "it.order_device", args: { worker_id: id } });
      expect(o.ok && o.status).toBe("pending_approval");
    }
    const h2 = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    expect(code(await w.executor.agent.exec(h2, { callId: "x", command: "it.order_device", args: { worker_id: "wrk_0014" } }))).toBe("OVER_CEILING");   // 4 x 189900 > 600000
  });

  it("at most 3 open R4 per run; the same (command, subject) supersedes", async () => {
    const a = await w.executor.agent.exec(h, { callId: "a", command: "payroll.submit_run", args: { run_id: "pay_2026_10_30" } });
    const b = await w.executor.agent.exec(h, { callId: "b", command: "payroll.submit_run", args: { run_id: "pay_2026_10_30", exclude_blocked: true } });
    expect(a.ok && b.ok).toBe(true);
    expect(await count(w.db, "proposals", "status = 'superseded'")).toBe(1);
    for (const id of ["wrk_0001", "wrk_0002"]) expect((await w.executor.agent.exec(h, { callId: id, command: "it.order_device", args: { worker_id: id } })).ok).toBe(true);
    expect(code(await w.executor.agent.exec(h, { callId: "4th", command: "it.order_device", args: { worker_id: "wrk_0003" } }))).toBe("NOT_PERMITTED");
  });
});

describe("system principals and the read-only executor", () => {
  it("every svc_ principal gets NOT_PERMITTED on every R2+ command", async () => {
    const r2plus = ["tax.update_rate", "people.set_pay_rate", "payroll.submit_run", "it.order_device", "comms.send_message"];
    const args: Record<string, unknown> = { "tax.update_rate": { rate_id: "etr_0001", rate: "0.015" }, "people.set_pay_rate": { worker_id: "wrk_0001", amount_cents: 1 },
      "payroll.submit_run": { run_id: "pay_2026_10_30" }, "it.order_device": { worker_id: "wrk_0001" }, "comms.send_message": { channel: "#general", text: "x" } };
    for (const svc of ["svc_scheduler", "svc_events", "svc_sim", "svc_digest"] as const) {
      for (const c of r2plus) expect(code(await w.executor.system.exec(svc, c, args[c], { eventId: null, attended: false, requestedBy: null }))).toBe("NOT_PERMITTED");
    }
    ok(await w.executor.system.exec("svc_events", "payroll.mark_processed", { run_id: "pay_2026_10_30" }, { eventId: "evt_0001", attended: false, requestedBy: null }));
    const [a] = await w.db.all<{ actor_kind: string }>(`SELECT actor_kind FROM actions` as never);
    expect(a!.actor_kind).toBe("system");
  });

  it("readOnly refuses anything but reads", async () => {
    ok(await w.executor.readOnly.exec("cmp_larkspur", "people.search", {}));
    expect(code(await w.executor.readOnly.exec("cmp_larkspur", "comms.send_message", { channel: "#general", text: "x" }))).toBe("NOT_PERMITTED");
  });
});
