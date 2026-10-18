// Fix group duplicate-proposal (docs/evals/model-comparison.md, the notices failure every setup shared): the agency
// notice routine is idempotent per notice. A second notice.received for the same notice, or a second copy of the same
// letter, proposes nothing new, and the executor hands back an open proposal instead of filing an equivalent one.
// Scripted provider (scenarios/rt_agency_notice.json), fresh world per test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow } from "@weft/contracts";
import { emitEvent } from "@weft/core";
import { notices, proposals, routineRuns, withWriteLock } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeEach(async () => { weft = await createTestWeft(); });
afterEach(async () => { await weft?.close(); });

const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });
const settled = (runId: string) => (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
const noticeRuns = () => weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));

/** Ticks until the routine has `n` runs that left running, settling any agent run among them. */
async function routineRunsSettled(n: number) {
  for (let i = 0; i < 40; i++) {
    await weft.scheduler.tick();
    const rows = await noticeRuns();
    if (rows.length >= n) {
      for (const r of rows) if (r.agentRunId) await settled(r.agentRunId);
      const again = await noticeRuns();
      if (again.every((r) => r.status !== "queued" && r.status !== "running")) return again;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`rt_agency_notice did not reach ${n} settled runs`);
}

async function deliver(scenario = "ca_de2088_rate_change"): Promise<string> {
  const res = await post("/v1/sim/notices/deliver", { scenario });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { data?: { notice_id?: string }; outcome?: { data?: { notice_id?: string } } };
  const id = body.data?.notice_id ?? body.outcome?.data?.notice_id;
  if (id) return id;
  const rows = await weft.db.select().from(notices);
  return rows.at(-1)!.id;
}

async function redeliverEvent(noticeId: string) {
  await withWriteLock(() => weft.db.transaction(async (tx) => {
    await emitEvent(tx as never, weft.clock as never, { body: { type: "notice.received", payload: { notice_id: noticeId } } as never, subjectRef: noticeId, attended: false, requestedBy: null });
  }));
}

const byCommand = async (command: string) => (await weft.db.select().from(proposals)).filter((p) => p.command === command);

describe("duplicate proposals on a tax notice", () => {
  it("two runs on one notice create one proposal of each kind", async () => {
    const noticeId = await deliver();
    const [first] = await routineRunsSettled(1);
    expect(first?.agentRunId).toBeTruthy();
    expect((await byCommand("tax.update_rate")).map((p) => p.status)).toEqual(["pending"]);
    expect((await byCommand("notices.send_response")).map((p) => p.status)).toEqual(["pending"]);

    await redeliverEvent(noticeId);
    const runs = await routineRunsSettled(2);
    const second = runs.find((r) => r.id !== first!.id)!;
    expect(second).toMatchObject({ status: "skipped", agentRunId: null });
    expect(second.summary).toContain(`Notice ${noticeId} is already being handled`);
    expect(await byCommand("tax.update_rate")).toHaveLength(1);
    expect(await byCommand("notices.send_response")).toHaveLength(1);
    expect((await weft.executor.verifyChain()).ok).toBe(true);
  });

  it("notices.get lists the proposals filed about a notice", async () => {
    const noticeId = await deliver();
    await routineRunsSettled(1);
    const res = await weft.executor.readOnly.exec("cmp_larkspur", "notices.get", { notice_id: noticeId });
    expect(res.ok && res.status === "done").toBe(true);
    const listed = ((res.ok && res.status === "done" ? res.data : null) as { notice: { proposals: { command: string; status: string }[]; duplicate_of: unknown } }).notice;
    expect(listed.proposals.map((p) => p.command).sort()).toEqual(["notices.send_response", "tax.update_rate"]);
    expect(listed.duplicate_of).toBeNull();
  });

  it("a second copy of the same letter is skipped while the first is being handled, and after it is resolved", async () => {
    const first = await deliver();
    await routineRunsSettled(1);
    const copy = await deliver();
    expect(copy).not.toBe(first);
    const runs = await routineRunsSettled(2);
    const skipped = runs.find((r) => r.status === "skipped")!;
    expect(skipped.summary).toContain(`Notice ${copy} repeats ${first}`);
    expect(await byCommand("tax.update_rate")).toHaveLength(1);

    for (const p of (await weft.db.select().from(proposals)).filter((x) => x.status === "pending")) {
      const res = await post(`/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const [n] = await weft.db.select().from(notices).where(eq(notices.id, first));
    expect(n?.status).toBe("resolved");
    const third = await deliver();
    const all = await routineRunsSettled(3);
    expect(all.find((r) => r.summary?.includes(`Notice ${third} repeats ${first}`))?.status).toBe("skipped");
    expect(await byCommand("tax.update_rate")).toHaveLength(1);
  });

  it("a different letter on the same form still runs: the injected DE 2088 is not a copy of the real one", async () => {
    await deliver();
    await routineRunsSettled(1);
    await deliver("ca_de2088_injection");
    const runs = await routineRunsSettled(2);
    expect(runs.filter((r) => r.agentRunId)).toHaveLength(2);
  });

  it("the executor hands an equivalent tool call the open proposal over the API", async () => {
    const noticeId = await deliver();
    await routineRunsSettled(1);
    const [rate] = await byCommand("tax.update_rate");
    const args = JSON.parse(rate!.argsJson!);
    expect(args.source_notice_id).toBe(noticeId);
    // The seeded MCP key proposes (an API caller never executes an approval-gated command).
    const key = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const res = await weft.app.request("/v1/tools/tax__update_rate", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(args) });
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, status: "pending_approval", proposalId: rate!.id, existing: true });
    expect(await byCommand("tax.update_rate")).toHaveLength(1);
  });
});
