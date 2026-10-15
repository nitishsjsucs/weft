import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecContext } from "@weft/contracts";
import { closeDb, migrate, openDb, routines, type Db } from "@weft/db";
import { routinesCommands } from "../commands/routines";
import type { CommandDeps } from "../shared/deps";
import { parseRoutineDraft } from "./draft-parser";

let dir: string;
let db: Db;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "weft-rtc-")); db = openDb({ dataDir: dir }); await migrate(db); });
afterEach(async () => { await closeDb(db); rmSync(dir, { recursive: true, force: true }); });

const ctx = (tainted = false): ExecContext => ({
  companyId: "cmp_larkspur", principal: { id: "usr_0001", kind: "human", role: "admin" }, onBehalfOf: null, surface: "human_ui", agentKind: null,
  run: null, tainted, routineRunId: null, approvedProposalId: null, now: "2026-10-26T16:00:00.000Z",
});
const deps = (): CommandDeps => ({
  tx: db, sims: {} as never, resolveCredential: async () => "", newId: async (p) => `${p}custom_0001`,
  clock: { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined },
});
const cmd = (name: string) => routinesCommands.find((c) => c.name === name)!;

describe("routines commands", () => {
  it("the parser plus routines.draft give a disabled routine on 0 9 * * 5 and a routine.drafted event", async () => {
    const p = parseRoutineDraft("Every Friday, post open approvals to #payroll");
    if (!p.ok) throw new Error("parse failed");
    const input = cmd("routines.draft").input.parse({ name: p.name, cron: p.cron, tz: p.tz, channel: p.channel, tools: p.tools, instructions: p.instructions, precheck: p.precheck });
    const out = await cmd("routines.draft").run(input, ctx(), deps());
    expect(out.data).toEqual({ routine_id: "rt_custom_0001", enabled: false });
    expect(out.events).toEqual([{ type: "routine.drafted", subjectRef: "rt_custom_0001", payload: { routine_id: "rt_custom_0001" } }]);
    const row = (await db.select().from(routines))[0]!;
    expect(row.enabled).toBe(false);
    expect(JSON.parse(row.triggerJson)).toEqual({ type: "cron", cron: "0 9 * * 5", tz: "America/Los_Angeles" });
    expect(JSON.parse(row.toolsJson)).toEqual(["comms.send_message"]);
  });

  it("draft refuses a bad cron, an unknown tool and a tainted run", async () => {
    const base = { name: "x", tz: "America/Los_Angeles", channel: "#payroll", instructions: "y" };
    await expect(cmd("routines.draft").run({ ...base, cron: "61 9 * * 5", tools: ["comms.send_message"] }, ctx(), deps())).rejects.toThrow(/not valid/);
    expect(cmd("routines.draft").input.safeParse({ ...base, cron: "0 9 * * 5", tools: ["payroll.submit_run"] }).success).toBe(false);
    await expect(cmd("routines.draft").run({ ...base, cron: "0 9 * * 5", tools: ["comms.send_message"] }, ctx(true), deps())).rejects.toThrow(/tainted/);
  });

  it("enable and disable are human_only and never tools", () => {
    for (const n of ["routines.enable", "routines.disable"]) expect(cmd(n)).toMatchObject({ access: "human_only", tiers: { main: "unavailable", task: "unavailable" }, mcp: "hidden" });
  });
});
