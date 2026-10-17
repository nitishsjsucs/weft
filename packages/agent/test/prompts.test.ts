// The frozen prompts after wave 4 FG4 (docs/evals/error-analysis.md FM1, FM2, FM4, FM5): the chat tools guide comes
// from the frozen chat allowlists, the chat role has a clarifying rule and a memory rule for why and habit questions,
// the routine role shows an escalation, and no dev task literal reaches a prompt (fixes are mechanisms, not answers).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_ACT_TOOLS, CHAT_TOOLS_W3 } from "@weft/contracts";
import { CHAT_HIDDEN_TOOLS } from "../src/loop";
import { chatToolsGuide, frozenPrompt, PROMPT_REVISION } from "../src/prompts/index";

const KINDS = ["chat", "routine", "routine_draft"] as const;
const wire = (n: string) => n.replace(".", "__");
const chatOffered = new Set([...CHAT_TOOLS_W3, ...CHAT_ACT_TOOLS].map(wire).filter((n) => !CHAT_HIDDEN_TOOLS.has(n)));
const guideOf = (p: string) => p.slice(p.indexOf("<tools_guide>"), p.indexOf("</tools_guide>"));
const guideNamespaces = (g: string) => [...g.matchAll(/^- ([a-z_]+) \(/gm)].map((m) => m[1]!);

describe("chat tools guide (FM2)", () => {
  it("lists exactly the namespaces chat is offered, from the frozen allowlists, and never a hidden tool", () => {
    const g = guideOf(frozenPrompt("chat"));
    const expected = [...new Set([...chatOffered].map((n) => n.split("__")[0]!))];
    expect(guideNamespaces(g).sort()).toEqual(expected.sort());
    for (const hidden of CHAT_HIDDEN_TOOLS) expect(g).not.toContain(hidden.split("__")[1]!);
    expect(guideNamespaces(g)).not.toContain("comms");
    expect(guideNamespaces(g)).not.toContain("onboarding");
  });

  it("renders whatever the lists hold: a read added to the allowlist appears, an act-only tool is marked", () => {
    const g = chatToolsGuide(["people.get", "onboarding.get_checklist", "comms.post_update"], ["expenses.get"], new Set(["comms__post_update"]));
    expect(guideNamespaces(g)).toEqual(["people", "onboarding", "expenses"]);
    expect(g).toContain("- onboarding (get_checklist): a new hire's checklist and its tasks.");
    expect(g).toContain("- expenses (when your tool list has them: get):");
    expect(g).not.toContain("comms");
  });

  it("every namespace__action the chat prompt names is a tool chat can be offered", () => {
    const named = [...frozenPrompt("chat").matchAll(/\b([a-z]+(?:_[a-z]+)*__[a-z_]+)\b/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((n) => n !== "namespace__action" && !chatOffered.has(n))).toEqual([]);
  });

  it("the routine prompts keep the full namespace guide", () => {
    for (const kind of ["routine", "routine_draft"] as const) {
      const g = guideOf(frozenPrompt(kind));
      for (const ns of ["onboarding", "it", "comms", "notices", "memory"]) expect(g, `${kind} ${ns}`).toContain(`- ${ns}:`);
    }
  });
});

describe("chat role rules (FM4, FM5)", () => {
  const chat = frozenPrompt("chat");
  it("asks one direct question naming the options when no single change follows or a name matches several records", () => {
    expect(chat).toContain("no single record or change follows from it");
    expect(chat).toContain("a name in it matches more than one record");
    expect(chat).toContain("one direct question, with a question mark, that names the options with their short ids");
    const ex = /<example name="unclear_change">[\s\S]*?Good answer shape: "([^"]+)"/.exec(chat)?.[1] ?? "";
    expect(ex.endsWith("?")).toBe(true);
    expect((ex.match(/\?/g) ?? []).length).toBe(1);
    // The old pointer-only line that pulled answers toward a digest plus "which screen does it" is gone.
    expect(chat).not.toContain("explain which routine or screen does it");
  });

  it("sends why and habit questions to memory with distinctive words and asks for the note id or path", () => {
    expect(chat).toContain("memory__search with one or two distinctive words from the question");
    expect(chat).toContain("never the whole sentence");
    expect(chat).toContain("Cite the note id or path the answer rests on.");
    expect(chat).toContain("marked untrusted is still a source");
    expect(chat).toContain("never describe a habit or a reason that no result states");
    expect(chat).toContain("the history is the evidence");
    expect(chat).toContain("a job title is not evidence of a habit");
  });
});

describe("routine role (FM1)", () => {
  it("the agency notice examples cover an escalation as well as a rate change", () => {
    const r = frozenPrompt("routine");
    expect(r).toContain('<example name="agency_notice">');
    const esc = /<example name="agency_notice_handoff">([\s\S]*?)<\/example>/.exec(r)?.[1] ?? "";
    expect(esc).toContain("notices__escalate");
    expect(esc).toContain("procedure");
    expect(esc).toContain("Never claim that a filing was made");
    expect(r).toContain("When the recall block holds a procedure for this kind of trigger, follow it where the checklist allows and cite its path");
  });
});

describe("prompt version and hygiene", () => {
  const version = `p-${createHash("sha256").update(KINDS.map((k) => frozenPrompt(k)).join("\n")).digest("hex").slice(0, 12)}`;

  it("is bumped from the round 2 baseline and pinned with its revision", () => {
    expect(version).not.toBe("p-0b43866f041b");
    // A wording change moves this hash: update it together with PROMPT_REVISION.
    expect({ revision: PROMPT_REVISION, version }).toEqual({ revision: "w4.r1", version: "p-598e27523eb9" });
  });

  it("stays frozen: byte-identical, no dates, no dashes, at least 1,024 tokens", () => {
    for (const k of KINDS) {
      const p = frozenPrompt(k);
      expect(frozenPrompt(k)).toBe(p);
      expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(p).not.toMatch(new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)));
      expect(p.length / 4.2, k).toBeGreaterThan(1024);
    }
  });

  it("carries no dev task literal: expected mentions, mutator names, people's names or long inputs", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const dir = join(root, "evals/suite/tasks/dev");
    const lits = new Set<string>();
    const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    const generic = new Set(["NY", "USD", "EUR", "Q3", "Oct", "Monday", "Approve", "Please", "OpenAI"]);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as { input: Record<string, unknown>; world: { mutators: string[] }; expect: Record<string, { finalText?: { mustMention?: string[] } | null }> };
      for (const v of Object.values(t.expect)) for (const m of v.finalText?.mustMention ?? []) lits.add(m);
      for (const m of t.world.mutators) lits.add(m.split(":")[0]!);
      const input = String(t.input.chat ?? t.input.portal ?? t.input.mention ?? "");
      if (input.split(/\s+/).length >= 4) lits.add(input);
      // Capitalized words after the first are names, vendors or places the task introduces.
      for (const w of input.split(/\s+/).slice(1)) { const c = w.replace(/[^A-Za-z]/g, ""); if (/^[A-Z][a-z]{2,}/.test(c) && !generic.has(c)) lits.add(c); }
    }
    expect(lits.size).toBeGreaterThan(20);
    for (const k of KINDS) {
      const p = norm(frozenPrompt(k));
      const leaked = [...lits].filter((l) => norm(l).trim() && p.includes(norm(l)));
      expect(leaked, k).toEqual([]);
    }
  });
});
