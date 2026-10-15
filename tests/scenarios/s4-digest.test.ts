// Scenario s4 (SPEC 12, 13). Owner: t4-agent. GP4 a routine runs on schedule and logs its run, then the
// create-your-own parser drafts a disabled routine and a routine_enable proposal. Scripted provider
// (scenarios/rt_people_digest.json). Skips itself until the merged world lands, naming the missing parts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { agentRuns, proposals, routines } from "@weft/db";
import { createTestWeft, type TestWeft } from "./helpers";

let weft: TestWeft;
let missing: string[] = [];
beforeAll(async () => {
  weft = await createTestWeft();
  missing = weft.stubs.filter((s) => ["sim", "executor", "agent", "routines"].includes(s) || s.startsWith("wiring"));
});
afterAll(async () => { await weft?.close(); });

const get = (path: string, who = "usr_dana") => weft.app.request(path, { headers: weft.uiHeaders(who) });
const post = (path: string, body: unknown, who = "usr_dana") => weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders(who), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GP4 a routine runs on schedule and logs its run", () => {
  it("runs end to end with the scripted provider (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    await weft.clock.advance("2026-10-26T16:00:00.000Z");   // +30 min from Mon 08:30 PT
    await weft.scheduler.tick();
    const page = (await (await get("/v1/routines/rt_people_digest/runs")).json()) as { data: RoutineRun[] };
    expect(page.data).toHaveLength(1);
    const run = page.data[0]!;
    expect(run.triggerRef).toBe("cron:2026-10-26T16:00:00.000Z");
    const agentRun = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId!);
    expect(agentRun).toMatchObject({ status: "done", tainted: false });
    const chat = (await (await get(`/v1/sim/chat?channel=${encodeURIComponent("#people-ops")}`)).json()) as { text: string }[];
    expect(chat.some((m) => m.text.includes("Weekly people digest"))).toBe(true);
    await weft.clock.advance("2026-10-26T16:10:00.000Z");
    await weft.scheduler.tick();
    expect(((await (await get("/v1/routines/rt_people_digest/runs")).json()) as { data: RoutineRun[] }).data).toHaveLength(1);
    const [row] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, run.agentRunId!));
    expect(row?.tainted).toBe(false);
  });

  it("the draft parser gives a disabled routine on 0 9 * * 5 and a routine_enable proposal (t4-agent)", async (ctx) => {
    if (missing.length) return ctx.skip(`waiting for: ${missing.join(", ")}`);
    const res = await post("/v1/routines/draft", { prompt: "Every Friday, post open approvals to #payroll" });
    expect(res.status, await res.clone().text()).toBe(200);
    const custom = (await weft.db.select().from(routines)).filter((r) => r.source === "custom");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ enabled: false });
    expect(JSON.parse(custom[0]!.triggerJson)).toEqual({ type: "cron", cron: "0 9 * * 5", tz: "America/Los_Angeles" });
    expect(JSON.parse(custom[0]!.toolsJson)).toEqual(["comms.send_message"]);
    const enable = (await weft.db.select().from(proposals)).filter((p) => p.kind === "routine_enable" && p.status === "pending");
    expect(enable).toHaveLength(1);
  });
});
