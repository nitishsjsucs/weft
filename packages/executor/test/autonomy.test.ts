// Wave 3 autonomy levels in policy() (docs/wave3.md, research/wave3/agent-parity.md 5.6). Owner: w3-parity-routines.
// recommend turns every R2 to R4 write into a suggestion; approve is today; auto executes an autoEligible R2 command at
// or under its limit in an untainted run with the company setting on, and never runs R4.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WeftCommand } from "@weft/core";
import { nullToUndefined, rawJsonSchema, sampleFromSchema, type PolicyFacts } from "../src/index";
import { policy, type AutonomyFacts } from "../src/policy";
import { builtinCommands } from "../src/builtins";
import { memoryCommands } from "../src/memory/commands";
import { fixtureCommands } from "./fixtures";

/** An expenses.decide-shaped R2 command that opts into auto under agent.expense_auto_cents. */
const decide: WeftCommand = {
  ...fixtureCommands.find((d) => d.name === "people.set_pay_rate")!,
  name: "expenses.decide_fixture", summary: "Decide one expense", input: z.object({ expense_id: z.string() }), risk: () => "R2", approval: "always", autoEligible: "agent.expense_auto_cents",
};
const all: WeftCommand[] = [...fixtureCommands, ...builtinCommands({ dataDir: "/nonexistent" } as never), ...memoryCommands({} as never), decide];
const sample = (d: WeftCommand) => (d.errorHints.INVALID_INPUT?.example as Record<string, unknown> | undefined) ?? (sampleFromSchema(rawJsonSchema(d.input)) as Record<string, unknown>);
const facts = (x: Partial<PolicyFacts> = {}): PolicyFacts => ({
  caller: "agent", agentKind: "main", tainted: false, taintedBy: null, blockedInBatch: false, pendingInBatch: false, amountCents: null, ceiling: null, openR4: 0, systemAllowed: false, ...x,
});
const level = (l: AutonomyFacts["level"], over: Partial<AutonomyFacts> = {}): AutonomyFacts => ({ level: l, allowAuto: true, autoLimitCents: 50_000, ...over });
const show = (d: ReturnType<typeof policy>) => `${d.decision}${d.code ? ` ${d.code}` : ""}${d.suggest ? " suggest" : ""}`;

describe("policy snapshot per autonomy level", () => {
  it("pins every command sample at recommend, approve and auto (amount 12,000 cents, limit 50,000)", () => {
    const snap: Record<string, string> = {};
    for (const d of all) {
      const i = d.input.parse(nullToUndefined(sample(d)));
      const at = (l: AutonomyFacts["level"]) => show(policy(d, i, facts({ amountCents: 12_000, autonomy: level(l) })));
      snap[d.name] = `${policy(d, i, facts()).risk} recommend ${at("recommend")} | approve ${at("approve")} | auto ${at("auto")}`;
    }
    expect(snap).toMatchInlineSnapshot(`
      {
        "actions.get_run": "R0 recommend execute | approve execute | auto execute",
        "actions.list": "R0 recommend execute | approve execute | auto execute",
        "agent.read_artifact": "R0 recommend execute | approve execute | auto execute",
        "code.run": "R0 recommend execute | approve execute | auto execute",
        "comms.post_update": "R1 recommend execute | approve execute | auto execute",
        "comms.send_message": "R3 recommend propose suggest | approve execute | auto execute",
        "expenses.decide_fixture": "R2 recommend propose suggest | approve propose | auto execute",
        "it.order_device": "R4 recommend propose suggest | approve propose | auto propose",
        "memory.read": "R0 recommend execute | approve execute | auto execute",
        "memory.search": "R0 recommend execute | approve execute | auto execute",
        "memory.write_note": "R1 recommend execute | approve execute | auto execute",
        "notices.get": "R0 recommend execute | approve execute | auto execute",
        "payroll.mark_processed": "R1 recommend propose | approve propose | auto propose",
        "payroll.preview_run": "R1 recommend execute | approve execute | auto execute",
        "payroll.submit_run": "R4 recommend propose suggest | approve propose | auto propose",
        "people.search": "R0 recommend execute | approve execute | auto execute",
        "people.set_pay_rate": "R2 recommend propose suggest | approve propose | auto propose",
        "routines.draft": "R1 recommend execute | approve execute | auto execute",
        "routines.enable": "R1 recommend execute | approve execute | auto execute",
        "tax.revert_rate": "R2 recommend propose suggest | approve propose | auto propose",
        "tax.update_rate": "R2 recommend propose suggest | approve propose | auto propose",
        "vault.list": "R0 recommend execute | approve execute | auto execute",
        "vault.request": "R1 recommend propose | approve propose | auto propose",
      }
    `);
  });

  it("approve and no autonomy are identical for every command, tainted or not", () => {
    for (const d of all) {
      const i = d.input.parse(nullToUndefined(sample(d)));
      for (const tainted of [false, true]) {
        const base = facts({ tainted, taintedBy: tainted ? "notice:ntc_0001" : null, amountCents: 12_000 });
        expect(policy(d, i, { ...base, autonomy: level("approve") }), d.name).toEqual(policy(d, i, base));
      }
    }
  });
});

describe("auto autonomy limits", () => {
  const i = { expense_id: "exp_0001" };
  it("executes an autoEligible R2 at or under the limit and proposes above it", () => {
    expect(policy(decide, i, facts({ amountCents: 50_000, autonomy: level("auto") })).decision).toBe("execute");
    const over = policy(decide, i, facts({ amountCents: 50_001, autonomy: level("auto") }));
    expect([over.decision, over.reason]).toEqual(["propose", "50001 cents is over the auto limit agent.expense_auto_cents (50000 cents), so it needs approval"]);
  });
  it("falls back to approve in a tainted run, with the setting off, with no amount, with no limit, or after a pending call", () => {
    const cases: Partial<PolicyFacts>[] = [
      { tainted: true, taintedBy: "expense:exp_0001", amountCents: 100, autonomy: level("auto") },
      { amountCents: 100, autonomy: level("auto", { allowAuto: false }) },
      { amountCents: null, autonomy: level("auto") },
      { amountCents: 100, autonomy: level("auto", { autoLimitCents: null }) },
      { amountCents: 100, pendingInBatch: true, autonomy: level("auto") },
    ];
    for (const c of cases) expect(policy(decide, i, facts(c)).decision, JSON.stringify(c)).toBe("propose");
  });
  it("never runs R4, whatever the amount, setting or limit", () => {
    for (const d of all) {
      const sampleIn = d.input.parse(nullToUndefined(sample(d)));
      if (policy(d, sampleIn, facts()).risk !== "R4") continue;
      for (const amountCents of [0, 1, 12_000, null]) {
        expect(policy({ ...d, autoEligible: "agent.expense_auto_cents" }, sampleIn, facts({ amountCents, autonomy: level("auto", { autoLimitCents: 10_000_000 }) })).decision, d.name).toBe("propose");
      }
    }
  });
  it("an R2 command without autoEligible stays a proposal at auto", () => {
    const pay = all.find((d) => d.name === "people.set_pay_rate")!;
    expect(policy(pay, pay.input.parse(nullToUndefined(sample(pay))), facts({ amountCents: 1, autonomy: level("auto") })).decision).toBe("propose");
  });
  it("ceilings still refuse before autonomy is considered", () => {
    const d = policy(decide, i, facts({ amountCents: 90_000, ceiling: { key: "agent.expense_cents", perCall: 80_000, day: null, daySpent: 0 }, autonomy: level("auto", { autoLimitCents: 100_000 }) }));
    expect([d.decision, d.code]).toEqual(["refuse", "OVER_CEILING"]);
  });
  it("humans, MCP and approved proposals ignore autonomy", () => {
    for (const caller of ["human", "mcp", "approved"] as const) {
      const base = facts({ caller, amountCents: 100 });
      expect(policy(decide, i, { ...base, autonomy: level("recommend") }), caller).toEqual(policy(decide, i, base));
    }
  });
});
