// Integrator check (docs/wave4.md section 7 rule 4): every wave 4 command matches its W4_PLANNED_COMMANDS row for
// risk, access and approval, and every planned row is either registered or listed as not built yet.
import { describe, expect, it } from "vitest";
import { W4_PLANNED_COMMANDS } from "@weft/contracts";
import { w4ComplianceCommands } from "../../../packages/core/src/commands/w4-compliance";
import { w4PeopleCommands } from "../../../packages/core/src/commands/w4-people";
import { w4AgentCommands } from "../../../packages/core/src/commands/w4-agent";
import { w4AdminCommands } from "../../../packages/core/src/commands/w4-admin";

/** Planned in the scaffold, not built in wave 4 (docs/tracks/w4-parity-agent.md, what is left). */
const NOT_BUILT = ["routines.list_waits", "routines.open_wait", "routines.resume_wait"];

describe("wave 4 planned commands", () => {
  const all = [...w4ComplianceCommands, ...w4PeopleCommands, ...w4AgentCommands, ...w4AdminCommands];
  it("every wave 4 command has a planned row with the same risk, access and approval", () => {
    for (const d of all) {
      const p = W4_PLANNED_COMMANDS.find((x) => x.name === d.name);
      expect(p, d.name).toBeDefined();
      expect([d.risk({} as never), d.access ?? "all", d.approval], d.name).toEqual([p!.risk, p!.access, p!.approval]);
    }
  });
  it("every planned row is registered unless it is listed as not built", () => {
    const missing = W4_PLANNED_COMMANDS.filter((p) => !all.some((d) => d.name === p.name)).map((p) => p.name);
    expect(missing.sort()).toEqual([...NOT_BUILT].sort());
  });
});
