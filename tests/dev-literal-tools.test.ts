// The dev-literal ban (docs/wave4.md section 4) reaches tool descriptions too: no registered command description or
// parameter description may carry a dev task's expected mention, an id from its expected proposals or end-state
// checks, or its long input. The prompt scan lives in packages/agent/test/prompts.test.ts; this one covers the tools.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commands } from "../packages/core/src/commands/index";

const root = resolve(import.meta.dirname, "..");
const ID = /\b(?:wrk|usr|exp|prp|pay|res|ntc|ven|inv|ben|doc|cnt|pto|rtn|req|off|onb|crd)_[A-Za-z0-9_]+\b/g;

function devLiterals(): Set<string> {
  const dir = join(root, "evals/suite/tasks/dev");
  const lits = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as { input: Record<string, unknown>; expect: Record<string, { proposals?: { args?: unknown }[] | null; finalText?: { mustMention?: string[] } | null; endState?: unknown } | null> };
    for (const v of Object.values(t.expect)) {
      if (!v) continue;
      for (const id of JSON.stringify(v.proposals ?? []).match(ID) ?? []) lits.add(id);
      for (const id of JSON.stringify(v.endState ?? []).match(ID) ?? []) lits.add(id);
      for (const m of v.finalText?.mustMention ?? []) if (!m.startsWith("!")) for (const alt of m.split("|")) for (const id of alt.match(ID) ?? []) lits.add(id);
    }
    const input = String(t.input.chat ?? t.input.portal ?? t.input.mention ?? "");
    if (input.split(/\s+/).length >= 4) lits.add(input);
  }
  return lits;
}

describe("tool descriptions carry no dev task literal", () => {
  it("scans every registered command description and parameter description", () => {
    const lits = devLiterals();
    expect(lits.size).toBeGreaterThan(5);
    const leaks: string[] = [];
    for (const c of commands) {
      let params = "";
      try { params = JSON.stringify(z.toJSONSchema(c.input as z.ZodType, { io: "input", unrepresentable: "any" })); } catch { params = ""; }
      const text = `${c.summary ?? ""}\n${c.description ?? ""}\n${params}`;
      for (const l of lits) if (text.includes(l)) leaks.push(`${c.name}: ${l}`);
    }
    expect(leaks).toEqual([]);
  });
});
