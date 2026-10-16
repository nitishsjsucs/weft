import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WeftCommand } from "@weft/core";
import { createRegistry, MAX_TOOLS, nullToUndefined, policy, rawJsonSchema, sampleFromSchema, strictSchemaProblems, toStrictJsonSchema, wireName, type PolicyFacts } from "../src/index";
import { builtinCommands } from "../src/builtins";
import { memoryCommands } from "../src/memory/commands";
import { fixtureCommands } from "./fixtures";

const all: WeftCommand[] = [...fixtureCommands, ...builtinCommands({ dataDir: "/nonexistent" } as never), ...memoryCommands({} as never)];
const registry = createRegistry(all);
const sample = (d: WeftCommand) => (d.errorHints.INVALID_INPUT?.example as Record<string, unknown> | undefined) ?? (sampleFromSchema(rawJsonSchema(d.input)) as Record<string, unknown>);

describe("strict schemas", () => {
  it("every command's schema is strict: additionalProperties false, all required, no bounds, keys sorted", () => {
    for (const d of all) expect(strictSchemaProblems(toStrictJsonSchema(d.input)), d.name).toEqual([]);
  });

  it("a record input is flagged: strict providers refuse propertyNames, and the rewritten object takes no keys", () => {
    const problems = strictSchemaProblems(toStrictJsonSchema(z.object({ bonus_cents: z.record(z.string(), z.number().int()).optional() })));
    expect(problems.some((p) => p.includes("propertyNames"))).toBe(true);
    expect(strictSchemaProblems(toStrictJsonSchema(z.object({ bonuses: z.array(z.object({ worker_id: z.string(), cents: z.number().int() })).optional() })))).toEqual([]);
  });

  it("optional fields become [T, null] unions", () => {
    const s = toStrictJsonSchema(z.object({ a: z.string().min(2), b: z.number().int().max(3).optional(), c: z.enum(["x", "y"]).optional() })) as { properties: Record<string, unknown>; required: string[] };
    expect(s.required).toEqual(["a", "b", "c"]);
    expect(s.properties).toEqual({ a: { type: "string" }, b: { type: ["integer", "null"] }, c: { enum: ["x", "y", null], type: ["string", "null"] } });
  });

  it("an all-null-optionals sample parses for every command after null mapping", () => {
    for (const d of all) {
      const raw = rawJsonSchema(d.input) as { properties?: Record<string, unknown>; required?: string[] };
      const base = sample(d);
      const withNulls: Record<string, unknown> = { ...base };
      for (const k of Object.keys(raw.properties ?? {})) if (!(raw.required ?? []).includes(k)) withNulls[k] = null;
      const r = d.input.safeParse(nullToUndefined(withNulls));
      expect(r.success, `${d.name}: ${JSON.stringify(withNulls)}`).toBe(true);
    }
  });
});

describe("registry", () => {
  it("wire names match the provider rule and descriptions are at most 400 characters", () => {
    for (const d of all) {
      expect(wireName(d.name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(registry.get(wireName(d.name))?.name).toBe(d.name);
      expect(d.description.length, d.name).toBeLessThanOrEqual(400);
    }
  });

  it("toolSpecs are sorted, frozen and capped at 16", () => {
    const specs = registry.toolSpecs({ agentKind: "main", allowlist: ["people.search", "notices.get", "comms.send_message", "actions.list"] });
    expect(specs.map((s) => s.name)).toEqual(["actions__list", "comms__send_message", "notices__get", "people__search"]);
    expect(Object.isFrozen(specs)).toBe(true);
    const many = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({ ...fixtureCommands[0]!, name: `people.read_${i}` as const }));
    const big = createRegistry(many);
    expect(() => big.toolSpecs({ agentKind: "main", allowlist: many.map((m) => m.name) })).toThrow(/cap of 16/);
    expect(big.toolSpecs({ agentKind: "main", allowlist: many.slice(0, 16).map((m) => m.name) })).toHaveLength(16);
    expect(() => registry.toolSpecs({ agentKind: "main", allowlist: ["routines.enable"] })).toThrow(/unavailable/);
  });
});

const facts = (x: Partial<PolicyFacts> = {}): PolicyFacts => ({
  caller: "agent", agentKind: "main", tainted: false, taintedBy: null, blockedInBatch: false, pendingInBatch: false, amountCents: null, ceiling: null, openR4: 0, systemAllowed: false, ...x,
});

describe("policy snapshot", () => {
  it("pins risk and decision for every command sample", () => {
    const snap: Record<string, string> = {};
    for (const d of all) {
      const i = d.input.parse(nullToUndefined(sample(d)));
      const p = policy(d, i, facts());
      const t = policy(d, i, facts({ tainted: true, taintedBy: "notice:ntc_0001" }));
      snap[d.name] = `${p.risk} ${p.decision}${p.code ? ` ${p.code}` : ""} | tainted ${t.decision}${t.code ? ` ${t.code}` : ""}`;
    }
    expect(snap).toMatchInlineSnapshot(`
      {
        "actions.get_run": "R0 execute | tainted execute",
        "actions.list": "R0 execute | tainted execute",
        "agent.read_artifact": "R0 execute | tainted execute",
        "code.run": "R0 execute | tainted execute",
        "comms.post_update": "R1 execute | tainted execute",
        "comms.send_message": "R3 execute | tainted propose",
        "it.order_device": "R4 propose | tainted propose",
        "memory.read": "R0 execute | tainted execute",
        "memory.search": "R0 execute | tainted execute",
        "memory.write_note": "R1 execute | tainted refuse TAINTED_WRITE",
        "notices.get": "R0 execute | tainted execute",
        "payroll.mark_processed": "R1 propose | tainted propose",
        "payroll.preview_run": "R1 execute | tainted execute",
        "payroll.submit_run": "R4 propose | tainted propose",
        "people.search": "R0 execute | tainted execute",
        "people.set_pay_rate": "R2 propose | tainted propose",
        "routines.draft": "R1 execute | tainted refuse TAINTED_WRITE",
        "routines.enable": "R1 execute | tainted execute",
        "tax.revert_rate": "R2 propose | tainted propose",
        "tax.update_rate": "R2 propose | tainted propose",
        "vault.list": "R0 execute | tainted execute",
        "vault.request": "R1 propose | tainted refuse TAINTED_WRITE",
      }
    `);
  });

  it("R2 and above never have approval never; no R4 command has autoAllow", () => {
    for (const d of all) {
      const r = policy(d, d.input.parse(nullToUndefined(sample(d))), facts()).risk;
      if (["R2", "R3", "R4"].includes(r) && d.access !== "system_only") expect(d.approval, d.name).not.toBe("never");
      if (r === "R4") expect(d.autoAllow, d.name).toBe("never");
    }
  });

  it("task agents never get autoAllow; system and read-only callers are bounded", () => {
    const send = all.find((d) => d.name === "comms.send_message")!;
    const i = { channel: "#general", text: "x" };
    expect(policy(send, i, facts({ agentKind: "task:it_provisioning" })).decision).toBe("propose");
    expect(policy(send, i, facts({ caller: "system", systemAllowed: true })).code).toBe("NOT_PERMITTED");
    expect(policy(send, i, facts({ caller: "readonly" })).code).toBe("NOT_PERMITTED");
    expect(policy(send, i, facts({ caller: "mcp" })).decision).toBe("propose");
  });
});
