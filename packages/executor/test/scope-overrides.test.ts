// Per-action overrides below the domain grant (wave 4, w4-parity-admin; harness 6.1, research/wave3/agent-parity.md G1).
// deny takes a command off an agent run's allowlist, so the model is never shown it and a call to it is refused
// UNAVAILABLE; propose_only turns an execute into a proposal. The agent's own row binds every run, a person's row
// binds runs that act for them, and nothing here widens a grant.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle } from "@weft/contracts";
import { agentActionOverrides } from "@weft/db";
import { executorInternals } from "../src/index";
import { actionOverrideOf, agentScope, loadActionOverrides, narrowAllowlist, narrowDecision, NO_OVERRIDES, resolveRun } from "../src/scope";
import { CMP, makeWorld, type World } from "./fixtures";

let w: World;
beforeEach(async () => { w = await makeWorld(); });
afterEach(async () => { await w.close(); });

let n = 0;
async function override(principalId: string, command: string, mode: "deny" | "propose_only") {
  await w.db.insert(agentActionOverrides).values({ id: `aov_${String(++n).padStart(4, "0")}`, companyId: CMP, principalId, command, mode, setBy: "usr_dana", setAt: "2026-10-26T15:30:00.000Z", proposalId: null });
}
const call = (h: RunHandle, command: string, args: unknown, id = `c${++n}`) => w.executor.agent.exec(h, { callId: id, command, args });
const chat = (who: string, allowlist?: string[]) => w.executor.runs.openChatRun(w.ui(who), { threadId: null, surface: "human_ui", ...(allowlist ? { allowlist } : {}) });

async function scopeOf(h: RunHandle) {
  const e = executorInternals(w.executor)!.engine;
  return w.db.transaction(async (tx) => {
    const row = (await resolveRun(tx, h))!;
    return agentScope(e, tx, row, h.token, null, null);
  });
}

describe("deny", () => {
  it("refuses the command as UNAVAILABLE for every run when set on the agent itself", async () => {
    const h = await chat("usr_dana");
    expect(await call(h, "people.search", { query: "Theo" })).toMatchObject({ ok: true, status: "done" });
    await override("agt_weft", "people.search", "deny");
    const o = await call(h, "people.search", { query: "Theo" });
    expect(o).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
    // Other commands are untouched.
    expect(await call(h, "notices.get", { notice_id: "ntc_0001" })).toMatchObject({ ok: true, status: "done" });
  });

  it("binds only the runs that act for the person it was set for", async () => {
    await override("usr_theo", "people.search", "deny");
    const dana = await chat("usr_dana"), theo = await chat("usr_theo");
    expect(await call(dana, "people.search", { query: "Sam" })).toMatchObject({ ok: true, status: "done" });
    expect(await call(theo, "people.search", { query: "Sam" })).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
  });

  it("takes the command off a frozen allowlist, so the tool list the model sees no longer has it", async () => {
    await override("usr_dana", "comms.send_message", "deny");
    const allow = ["comms.send_message", "people.search"];
    const h = await chat("usr_dana", allow);
    const s = await scopeOf(h);
    expect(JSON.parse(s.run!.allowlistJson!)).toEqual(["people.search"]);
    const o = await loadActionOverrides(w.db, CMP, ["agt_weft", "usr_dana"]);
    expect(narrowAllowlist(allow, o)).toEqual(["people.search"]);
    expect(w.executor.registry.toolSpecs({ agentKind: "main", allowlist: narrowAllowlist(allow, o) }).map((t) => t.name)).toEqual(["people__search"]);
    expect(await call(h, "comms.send_message", { channel: "#general", text: "hello" })).toMatchObject({ ok: false, refusal: { code: "UNAVAILABLE" } });
    expect(await call(h, "people.search", { query: "Sam" })).toMatchObject({ ok: true, status: "done" });
  });

  it("never touches human calls", async () => {
    await override("usr_dana", "people.search", "deny");
    expect(await w.executor.human.exec(w.ui("usr_dana"), "people.search", { query: "Sam" })).toMatchObject({ ok: true, status: "done" });
  });
});

describe("propose_only", () => {
  it("is read into the agent's call scope and turns an execute into a proposal", async () => {
    await override("usr_dana", "comms.send_message", "propose_only");
    const s = await scopeOf(await chat("usr_dana"));
    expect(actionOverrideOf(s, "comms.send_message")).toBe("propose_only");
    expect(actionOverrideOf(s, "people.search")).toBeNull();
    const exec = { risk: "R3", decision: "execute" as const, code: null, reason: "auto-allowed for an untainted main agent" };
    expect(narrowDecision(exec, "propose_only", false)).toMatchObject({ decision: "propose" });
    // Reads never propose; refusals and proposals stay as they are.
    expect(narrowDecision(exec, "propose_only", true)).toBe(exec);
    const refused = { risk: "R3", decision: "refuse" as const, code: "TAINTED_WRITE", reason: "x" };
    expect(narrowDecision(refused, "propose_only", false)).toBe(refused);
    expect(narrowDecision(exec, null, false)).toBe(exec);
  });

  it("deny wins over propose_only when the agent row and the person row disagree", async () => {
    await override("agt_weft", "comms.send_message", "deny");
    await override("usr_dana", "comms.send_message", "propose_only");
    const s = await scopeOf(await chat("usr_dana"));
    expect(actionOverrideOf(s, "comms.send_message")).toBe("deny");
  });

  it("applies to agent callers only", () => {
    const o = { deny: new Set<string>(), proposeOnly: new Set(["comms.send_message"]) };
    expect(actionOverrideOf({ caller: "human", overrides: o }, "comms.send_message")).toBeNull();
    expect(actionOverrideOf({ caller: "agent", overrides: o }, "comms.send_message")).toBe("propose_only");
    expect(actionOverrideOf({ caller: "agent" }, "comms.send_message")).toBeNull();
    expect(narrowAllowlist(["a.b"], NO_OVERRIDES)).toEqual(["a.b"]);
  });

  it("an agent call to a propose_only command returns pending_approval through the pipeline", async () => {
    // Without an override the untainted main agent's post runs (R3, autoAllow untainted).
    const free = await chat("usr_dana");
    expect(await call(free, "comms.send_message", { channel: "#general", text: "hello" })).toMatchObject({ ok: true, status: "done" });
    await override("usr_dana", "comms.send_message", "propose_only");
    const h = await chat("usr_dana");
    const o = await call(h, "comms.send_message", { channel: "#general", text: "hello again" });
    expect(o).toMatchObject({ ok: true, status: "pending_approval" });
    const id = (o as { proposalId: string }).proposalId;
    const [p] = await w.db.all<{ status: string; command: string }>(sql`SELECT status, command FROM proposals WHERE id = ${id}`);
    expect(p).toEqual({ status: "pending", command: "comms.send_message" });
    // Reads under the same override still run, and the person's own calls are never narrowed.
    await override("usr_dana", "people.search", "propose_only");
    expect(await call(h, "people.search", { query: "Sam" })).toMatchObject({ ok: true, status: "done" });
    expect(await w.executor.human.exec(w.ui("usr_dana"), "comms.send_message", { channel: "#general", text: "from Dana" })).toMatchObject({ ok: true, status: "done" });
  });

  it("forces a proposal in a run acting for another person only when that person set it", async () => {
    await override("usr_sam", "comms.send_message", "propose_only");
    expect(await call(await chat("usr_dana"), "comms.send_message", { channel: "#general", text: "one" })).toMatchObject({ ok: true, status: "done" });
    expect(await call(await chat("usr_sam"), "comms.send_message", { channel: "#general", text: "two" })).toMatchObject({ ok: true, status: "pending_approval" });
  });
});
