// Procedure and decision recall, and procedure citations (wave 4 round 2, FG2; docs/evals/round1-analysis.md R2 and
// R3). A recall hit in knowledge/procedures/ or knowledge/decisions/ used to be the one matched line, often the note's
// heading, so the steps never reached the run. Now it is the note's body excerpt with its id and cite, ranked above
// the other hits; trustedOnly still drops every tainted note and every decision. procedure_ref is checked by the
// executor: only an existing, untainted knowledge/procedures/ note can be cited.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunHandle } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { fixtureCommands, makeWorld, type World } from "./fixtures";
import { renderRecall, type RecallCandidate } from "../src/memory/recall";
import { checkProcedureRef, withMemoryCitations } from "../src/memory/citations";

const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.close(); });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mem = any;

const STEPS = "# Missing return notices\n\nFor a notice that says a return is missing:\n\n1. Read the notice and the period.\n2. Do not reply that the return was filed.\n3. Escalate with notices.escalate and name the period.\n";
async function seed(w: World, files: { path: string; id: string; type: string; body: string; taintedBy?: string | null }[]) {
  const m = w.executor.memory as Mem;
  for (const f of files) {
    await m.write({
      path: f.path, body: f.body, message: `note: ${f.path}`, author: { name: "Vic Akisole", email: "usr_vic.akisole@larkspur.example" },
      frontmatter: { id: f.id, type: f.type, aliases: [], links: [], sources: ["runbook"], status: null, updated: "2026-10-01", taintedBy: f.taintedBy ?? null },
    });
  }
  return m;
}
async function world(): Promise<{ w: World; h: RunHandle }> {
  const w = await makeWorld();
  worlds.push(w);
  return { w, h: await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" }) };
}

describe("procedure and decision recall (R2)", () => {
  it("a procedure hit renders the note's steps with its id and path, ranked above a timeline hit", async () => {
    const { w } = await world();
    const m = await seed(w, [{ path: "knowledge/procedures/missing-return.md", id: "proc-missing-return", type: "procedure", body: STEPS }]);
    await m.appendTimeline({ at: "2026-10-26T15:30:00.000Z", command: "sim.deliver_notice", text: "Delivered a missing return notice", importance: 1, source: "action:2", chainHead: { seq: 2, hash: "0".repeat(64) } });
    const out = await m.recall({ request: "missing return", subjectRefs: [], trustedOnly: true });
    const lines = (out.block as string).split("\n");
    const proc = lines.findIndex((l) => /^- knowledge\/procedures\/missing-return\.md#L\d+ \(procedure, as of 2026-10-01\): id proc-missing-return\. /.test(l));
    expect(proc, out.block).toBeGreaterThan(0);
    // The steps, not the heading line the search matched first.
    expect(lines[proc]).toContain("1. Read the notice and the period. / 2. Do not reply that the return was filed. / 3. Escalate with notices.escalate and name the period.");
    expect(lines[proc]).not.toContain("# Missing return notices");
    const timeline = lines.findIndex((l) => l.startsWith("- timeline/raw/"));
    expect(timeline).toBeGreaterThan(proc);
    expect(out.items.find((i: { path: string }) => i.path.startsWith("knowledge/procedures/missing-return.md#L"))).toMatchObject({ kind: "procedure", taintedBy: null });
  });

  it("a tainted procedure and a decision are untrusted: shown to chat as untrusted, never to a routine run", async () => {
    const { w } = await world();
    const m = await seed(w, [
      { path: "knowledge/procedures/missing-return.md", id: "proc-missing-return", type: "procedure", body: STEPS, taintedBy: "email:sim_0007" },
      { path: "knowledge/decisions/DEC-0042-missing-return.md", id: "DEC-0042", type: "decision", body: "# Missing return reply\n\nWe reply to missing return notices only after Finance checks the filing record.\n" },
    ]);
    const chat = await m.recall({ request: "missing return", subjectRefs: [] });
    expect(chat.block).toMatch(/- knowledge\/procedures\/missing-return\.md#L\d+ \(procedure, as of 2026-10-01, untrusted\): id proc-missing-return\. /);
    expect(chat.block).toMatch(/- knowledge\/decisions\/DEC-0042-missing-return\.md#L\d+ \(decision, as of 2026-10-01, untrusted\): We reply to missing return notices only after Finance checks the filing record\./);
    const routine = await m.recall({ request: "missing return", subjectRefs: [], trustedOnly: true });
    expect(routine.block).not.toContain("knowledge/procedures/missing-return.md");
    expect(routine.block).not.toContain("knowledge/decisions/");
    expect(routine.items.every((i: { taintedBy: string | null }) => !i.taintedBy)).toBe(true);
  });

  it("notes rank after dossiers and before hits, and are capped like a dossier", () => {
    const c = (kind: RecallCandidate["kind"], path: string, excerpt: string, score: number): RecallCandidate => ({ kind, path, title: path, excerpt, score, asOf: "2026-10-26", taintedBy: null });
    const { kept } = renderRecall([c("hit", "timeline/raw/2026-10-26.md#L3", "a hit", 99), c("procedure", "knowledge/procedures/a.md", "x".repeat(2000), 1), c("dossier", "entities/people/wrk_0001.md", "dossier", 1)]);
    expect(kept.map((k) => k.kind)).toEqual(["dossier", "procedure", "hit"]);
    expect(kept[1]!.excerpt.length).toBeLessThanOrEqual(220 * 4);
    expect(kept[1]!.excerpt.endsWith("[clipped]")).toBe(true);
  });
});

describe("procedure_ref is checked by the executor (R3)", () => {
  it("accepts an existing untainted procedure and refuses a missing, tainted or out-of-folder one", async () => {
    const { w } = await world();
    const m = await seed(w, [
      { path: "knowledge/procedures/missing-return.md", id: "proc-missing-return", type: "procedure", body: STEPS },
      { path: "knowledge/procedures/untrusted.md", id: "proc-untrusted", type: "procedure", body: STEPS, taintedBy: "email:sim_0007" },
      { path: "knowledge/decisions/DEC-0042.md", id: "DEC-0042", type: "decision", body: "# Decision\n\nA decision.\n" },
    ]);
    expect(await checkProcedureRef(m, "knowledge/procedures/missing-return.md")).toBe("knowledge/procedures/missing-return.md");
    const code = async (ref: string) => { try { await checkProcedureRef(m, ref); return "ok"; } catch (e) { return (e as { extra?: { code?: string } }).extra?.code ?? String(e); } };
    expect(await code("knowledge/procedures/no-such-note.md")).toBe("UNKNOWN_REFERENCE");
    expect(await code("knowledge/procedures/untrusted.md")).toBe("NOT_PERMITTED");
    expect(await code("knowledge/decisions/DEC-0042.md")).toBe("UNKNOWN_REFERENCE");
    expect(await code("knowledge/procedures/../decisions/DEC-0042.md")).toBe("UNKNOWN_REFERENCE");
    expect(await code("knowledge/procedures/a/../../decisions/DEC-0042.md")).toBe("UNKNOWN_REFERENCE");
    expect(await code("/etc/passwd.md")).toBe("UNKNOWN_REFERENCE");
  });

  it("the registry wraps only commands that take procedure_ref, and a refused reference never runs the command", async () => {
    let ran = 0;
    const escalate: WeftCommand = {
      ...fixtureCommands.find((c) => c.effect === "draft")!,
      name: "notices.escalate", namespace: "notices", summary: "Escalate (fixture)", description: "Escalate a notice (fixture).",
      input: z.object({ notice_id: z.string(), procedure_ref: z.string().optional() }),
      risk: () => "R1", approval: "never", preview: null,
      async run(i: { notice_id: string; procedure_ref?: string }) { ran++; return { data: { notice_id: i.notice_id, procedure_ref: i.procedure_ref ?? null }, summary: `Escalated ${i.notice_id}${i.procedure_ref ? ` per ${i.procedure_ref}` : ""}` }; },
    };
    const wrapped = withMemoryCitations({ read: async () => null }, [...fixtureCommands, escalate]);
    expect(wrapped.filter((c, i) => c !== [...fixtureCommands, escalate][i]).map((c) => c.name)).toEqual(["notices.escalate"]);

    const w = await makeWorld({ commands: [...fixtureCommands, escalate] });
    worlds.push(w);
    await seed(w, [{ path: "knowledge/procedures/missing-return.md", id: "proc-missing-return", type: "procedure", body: STEPS }]);
    // One run per call: a refusal skips the rest of its batch (harness 4.6).
    const run = () => w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    const bad = await w.executor.agent.exec(await run(), { callId: "c1", command: "notices.escalate", args: { notice_id: "ntc_0001", procedure_ref: "knowledge/procedures/no-such-note.md" } });
    expect(bad).toMatchObject({ ok: false, refusal: { code: "UNKNOWN_REFERENCE" } });
    expect((bad as { refusal: { hint: string | null } }).refusal.hint).toContain("leave it null");
    expect(ran).toBe(0);
    const good = await w.executor.agent.exec(await run(), { callId: "c2", command: "notices.escalate", args: { notice_id: "ntc_0001", procedure_ref: "knowledge/procedures/missing-return.md" } });
    expect(good, JSON.stringify(good)).toMatchObject({ ok: true, status: "done", summary: "Escalated ntc_0001 per knowledge/procedures/missing-return.md" });
    const none = await w.executor.agent.exec(await run(), { callId: "c3", command: "notices.escalate", args: { notice_id: "ntc_0001", procedure_ref: null } });
    expect(none).toMatchObject({ ok: true, status: "done", summary: "Escalated ntc_0001" });
    expect(ran).toBe(2);
  });
});
