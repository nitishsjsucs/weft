// Scenario GP16 (docs/wave3.md), the autonomy control and the agent settings. Owner: w3-parity-routines.
// Settings default off and change only through the UI session as an admin; an autonomy change is a proposal that
// executes only when approved; auto needs agent.allow_auto_autonomy; a routine at recommend files suggestions and
// posts nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ROUTES, type AgentRunRow, type RoutineRun } from "@weft/contracts";
import { proposals, routines, workers } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => {
  for (let i = 0; i < 10; i++) {
    const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
    if (!open.length) break;
    for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
  }
  await weft?.close();
});

const call = async (method: string, path: string, body?: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const autonomyOf = async (id: string) => (await weft.db.select({ a: routines.autonomy }).from(routines).where(eq(routines.id, id)))[0]?.a;

describe("GP16 agent settings", () => {
  it("both settings default off; PUT is ui_only and admin only", async () => {
    expect((await call("GET", "/v1/settings/agent")).json).toEqual({ chatCanPropose: false, allowAutoAutonomy: false });
    expect(ROUTES.find((r) => r.method === "PUT" && r.path === "/v1/settings/agent")?.auth).toBe("ui_only");
    expect((await call("PUT", "/v1/settings/agent", { allowAutoAutonomy: true }, "usr_sam")).status).toBe(403);
    expect((await call("GET", "/v1/settings/agent")).json.allowAutoAutonomy).toBe(false);
    expect((await call("PUT", "/v1/settings/agent", { bogus: true })).status).toBe(400);
  });
});

describe("GP16 autonomy control", () => {
  it("an autonomy change is a proposal, applied only on approval", async () => {
    await call("GET", "/v1/routines");   // seeds the prebuilt rows
    expect(await autonomyOf("rt_milestones")).toBe("approve");
    const filed = await call("POST", "/v1/routines/rt_milestones/autonomy", { autonomy: "recommend" });
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({ ok: true, status: "pending_approval" });
    expect(await autonomyOf("rt_milestones")).toBe("approve");
    const [p] = await weft.db.select().from(proposals).where(eq(proposals.id, filed.json.proposalId));
    expect(p).toMatchObject({ kind: "action", command: "routines.set_autonomy", subjectRef: "rt_milestones", status: "pending" });
    expect(JSON.parse(p!.diffJson)).toEqual([{ label: "autonomy", before: "approve", after: "recommend" }]);
    const ok = await call("POST", `/v1/proposals/${p!.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await autonomyOf("rt_milestones")).toBe("recommend");
  });

  it("running set_autonomy directly is refused, even for an admin", async () => {
    const r = await call("POST", "/v1/tools/routines.set_autonomy", { routine_id: "rt_milestones", autonomy: "approve" });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("NOT_PERMITTED");
    expect(await autonomyOf("rt_milestones")).toBe("recommend");
  });

  it("auto is refused while the setting is off and can be proposed once it is on", async () => {
    const off = await call("POST", "/v1/routines/rt_exec_briefing/autonomy", { autonomy: "auto" });
    expect(off.status).toBe(422);
    expect(off.json.code).toBe("DOMAIN_AUTO_AUTONOMY_OFF");
    expect((await call("PUT", "/v1/settings/agent", { allowAutoAutonomy: true })).json).toEqual({ chatCanPropose: false, allowAutoAutonomy: true });
    const on = await call("POST", "/v1/routines/rt_exec_briefing/autonomy", { autonomy: "auto" });
    expect(on.json).toMatchObject({ ok: true, status: "pending_approval" });
    expect((await call("POST", `/v1/proposals/${on.json.proposalId}/approve`, {})).status).toBe(200);
    expect(await autonomyOf("rt_exec_briefing")).toBe("auto");
    expect((await call("POST", "/v1/routines/rt_exec_briefing/autonomy", { autonomy: "auto" })).status).toBe(422);   // no change
  });

  it("a routine at recommend files its post as an Inbox suggestion and posts nothing", async () => {
    const people = (await weft.db.select().from(workers)).filter((w) => w.status === "active" && w.startDate < "2026-01-01");
    const day = people.map((w) => `2026-${w.startDate.slice(5)}`).filter((d) => d >= "2026-11-02").sort()[0]!;
    await weft.clock.set(`${day}T17:00:00.000Z`, 0);
    const { json } = await call("POST", "/v1/routines/rt_milestones/trigger", {});
    const engine = weft.routines as unknown as { settled(id: string): Promise<RoutineRun>; drain(ms?: number): Promise<boolean>; getRun(id: string): Promise<RoutineRun> };
    const first = await engine.settled(json.routineRunId);
    if (first.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(first.agentRunId);
    await engine.drain(5_000);
    const run = await engine.getRun(first.id);
    expect(run.status).toBe("waiting_approval");
    const general = (await call("GET", `/v1/sim/chat?channel=${encodeURIComponent("#general")}`)).json as { text: string }[];
    expect(general.some((m) => m.text.startsWith("Milestones today"))).toBe(false);
    const sug = (await weft.db.select().from(proposals).where(eq(proposals.kind, "suggestion"))).filter((p) => p.command === "comms.send_message" && p.status === "pending");
    expect(sug).toHaveLength(1);
    expect(sug[0]!.routineRunId).toBe(run.id);
    expect(JSON.parse(sug[0]!.contentJson)[0].text).toContain("Milestones today");
    expect(run.leftForHuman).toEqual([`Review the suggestion comms.send_message (${sug[0]!.id})`]);
  });
});
