// The governance invariants over the composed command set: every command @weft/core exports (empty in this worktree,
// T1 and T2 after merge 1) plus the executor's own builtins. The fixture tests pin behavior; this file makes sure the
// real commands obey the same rules the moment they land.
import { describe, expect, it } from "vitest";
import { commands as coreCommands, type WeftCommand } from "@weft/core";
import { rawJsonSchema, sampleFromSchema, strictSchemaProblems, toStrictJsonSchema, nullToUndefined, wireName } from "../src/index";
import { builtinCommands } from "../src/builtins";
import { memoryCommands } from "../src/memory/commands";
import { SYSTEM_ALLOWLISTS } from "../src/system";

const all: WeftCommand[] = [...coreCommands, ...builtinCommands({ dataDir: "/nonexistent" } as never), ...memoryCommands({} as never)];
const RANK = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const;

/** The highest risk a command can report: constant risk functions ignore the input; others get a sample. */
function riskOf(d: WeftCommand): keyof typeof RANK {
  const sample = (d.errorHints.INVALID_INPUT?.example as Record<string, unknown> | undefined) ?? (sampleFromSchema(rawJsonSchema(d.input)) as Record<string, unknown>);
  const parsed = d.input.safeParse(nullToUndefined(sample));
  try { return d.risk((parsed.success ? parsed.data : sample) as never); } catch { return "R4"; }
}

describe("composed command set", () => {
  it("names are unique, wire names follow the provider rule, descriptions fit in 400 characters", () => {
    expect(new Set(all.map((d) => d.name)).size).toBe(all.length);
    expect(new Set(all.map((d) => wireName(d.name))).size).toBe(all.length);
    for (const d of all) {
      expect(wireName(d.name), d.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(d.description.length, d.name).toBeLessThanOrEqual(400);
    }
  });

  it("every input schema converts to a strict schema", () => {
    for (const d of all) expect(strictSchemaProblems(toStrictJsonSchema(d.input)), d.name).toEqual([]);
  });

  it("R2 and above never have approval never; no R4 command has autoAllow", () => {
    for (const d of all) {
      const r = riskOf(d);
      if (RANK[r] >= 2 && d.access !== "system_only") expect(d.approval, d.name).not.toBe("never");
      if (r === "R4") expect(d.autoAllow, d.name).toBe("never");
    }
  });

  it("human_only and system_only commands are unavailable to the model and hidden from MCP", () => {
    for (const d of all.filter((x) => x.access !== "all")) {
      expect(d.tiers, d.name).toEqual({ main: "unavailable", task: "unavailable" });
      expect(d.mcp, d.name).toBe("hidden");
    }
  });

  it("every system_only command is on a svc_ allowlist, and the allowlists name only R0 or R1 commands that exist", () => {
    const listed = new Set(Object.values(SYSTEM_ALLOWLISTS).flat());
    for (const d of all.filter((x) => x.access === "system_only")) expect(listed.has(d.name), `${d.name} is system_only but no svc_ principal may run it`).toBe(true);
    const byName = new Map(all.map((d) => [d.name, d]));
    for (const name of listed) {
      const d = byName.get(name);
      if (!d) continue;   // lands with T1 or T2
      expect(d.access === "system_only" || RANK[riskOf(d)] <= 1, `${name} on a svc_ allowlist is ${riskOf(d)}`).toBe(true);
    }
  });
});
