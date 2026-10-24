// Scenario GP18, routine half (docs/wave3.md 5). Owner: w3-integrations-screening-esign. Scripted provider.
// rt_screening_follow_up runs on offer.accepted: its precheck reads the offer's check status and the package catalog,
// the model proposes screening.order with the derived arguments, and the proposal is R4 at the database price. The
// script is pinned here in a temp WEFT_SCRIPTS_DIR next to copies of the repo's scenarios (the repo copy of
// scenarios/rt_screening_follow_up.json lands with the routine at the wave 3 merge). A second acceptance of the same
// offer is impossible, so the skip paths run through the precheck directly against the read-only executor.
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AgentRunRow, ReadOnlyExecutor, RoutineRun } from "@weft/contracts";
import { routines } from "@weft/db";
import { RT_SCREENING_FOLLOW_UP as R, prechecks, screeningFollowUp } from "../../packages/routines/src/wave3/screening";
import { createTestWeft, type TestWeft } from "./helpers";

const SCRIPT = {
  agents: {
    main: [
      { output: [{ type: "function_call", name: "screening__order", arguments: "{{derived.screening.order}}" }] },
      { output: [{ type: "text", text: "Proposed the background check; it waits for approval in the inbox." }] },
    ],
  },
};
const CANDIDATE = { candidateFirst: "Avery", candidateLast: "Quill", candidateEmail: "avery.quill@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };

describe("GP18 rt_screening_follow_up", () => {
  let weft: TestWeft;
  const scripts = mkdtempSync(join(tmpdir(), "weft-gp18-scripts-"));
  const prev = process.env.WEFT_SCRIPTS_DIR;
  beforeAll(async () => {
    const repo = join(import.meta.dirname, "../../scenarios");
    for (const f of readdirSync(repo)) if (f.endsWith(".json")) copyFileSync(join(repo, f), join(scripts, f));
    writeFileSync(join(scripts, `${R.id}.json`), JSON.stringify(SCRIPT));
    process.env.WEFT_SCRIPTS_DIR = scripts;
    weft = await createTestWeft();
    await (weft.routines as unknown as { ensurePrebuilt(): Promise<void> }).ensurePrebuilt();
  });
  const settleAll = async () => {
    for (let i = 0; i < 10; i++) {
      const open = await weft.db.all<{ id: string }>(sql`SELECT id FROM routine_runs WHERE status IN ('queued', 'running')`);
      const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
      if (!open.length && !runs.length) break;
      for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
      for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    }
  };
  afterAll(async () => {
    await weft.scheduler.tick();
    await settleAll();
    await weft.close();
    if (prev === undefined) delete process.env.WEFT_SCRIPTS_DIR; else process.env.WEFT_SCRIPTS_DIR = prev;
    rmSync(scripts, { recursive: true, force: true });
  });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const readOnly = () => (weft.executor as unknown as { readOnly: ReadOnlyExecutor }).readOnly;

  it("ships disabled, event-triggered on offer.accepted, with at most 8 tools and no human-only screening command", () => {
    expect(R).toMatchObject({ enabled: false, autonomy: "approve", trigger: { type: "event", event: "offer.accepted" }, precheck: "screening_follow_up" });
    expect(R.tools.length).toBeLessThanOrEqual(8);
    expect(R.tools.filter((t) => /adverse|engage|review|proceed/.test(t))).toEqual([]);
    expect(prechecks.screening_follow_up).toBe(screeningFollowUp);
  });

  let offerId = "";
  it("on acceptance the model proposes screening.order as an R4 proposal at the catalog price, and nothing is ordered yet", async () => {
    await weft.db.insert(routines).values({
      id: R.id, companyId: "cmp_larkspur", name: R.name, description: R.description, ownerPrincipalId: R.ownerPrincipalId, enabled: true, autonomy: R.autonomy,
      triggerJson: JSON.stringify(R.trigger), filterJson: null, instructions: R.instructions, toolsJson: JSON.stringify(R.tools), precheck: R.precheck,
      checklistJson: JSON.stringify(R.checklist), budgetJson: JSON.stringify(R.budget), surfaceJson: JSON.stringify(R.surface), source: R.source, taintedBy: null, createdAt: weft.clock.now(),
    }).onConflictDoNothing();
    await weft.db.run(sql`UPDATE routines SET enabled = 1 WHERE id = ${R.id}`);
    offerId = (await call("usr_dana", "POST", "/v1/offers", CANDIDATE)).json.data.offer_id as string;
    const persona = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data.persona_principal_id as string;
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    expect((await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: "Avery Quill", documentSha256: letter.sha256 })).json.data.offer_status).toBe("accepted");
    await weft.scheduler.tick();
    await settleAll();

    const [rr] = await weft.db.all<{ id: string; status: string; agent_run_id: string | null; trigger_ref: string }>(sql`SELECT id, status, agent_run_id, trigger_ref FROM routine_runs WHERE routine_id = ${R.id}`);
    expect(rr, "the routine ran on offer.accepted").toBeTruthy();
    const run = await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(rr!.id);
    expect(run.status, JSON.stringify(run)).toBe("waiting_approval");
    expect(run.leftForHuman).toEqual([expect.stringMatching(/^Approve screening\.order \(prp_/)]);
    expect(run.summary).toMatch(/Standard.*\$35\.00/);
    const agentRun = await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId!);
    expect(agentRun).toMatchObject({ status: "waiting", tainted: false });

    const props = await weft.db.all<{ command: string; risk: string; status: string; money_cents: number | null; args_json: string }>(sql`SELECT * FROM proposals WHERE command = 'screening.order'`);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ risk: "R4", status: "pending" });
    const [pkg] = await weft.db.all<{ price_cents: number }>(sql`SELECT price_cents FROM screening_packages WHERE vendor = 'checkr' AND slug = 'weft_standard_sim'`);
    expect(JSON.stringify(props[0])).toContain(String(pkg!.price_cents));
    expect(JSON.parse(props[0]!.args_json)).toMatchObject({ offer_id: offerId });
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM screening_orders`))[0]!.n).toBe(0);
    // The run's steps never carry record text: the routine has no review or adverse tool to call.
    const steps = await weft.db.all<{ tool_name: string | null }>(sql`SELECT tool_name FROM run_steps WHERE run_id = ${run.agentRunId} AND tool_name IS NOT NULL`);
    expect(steps.map((s) => s.tool_name)).toContain("screening__order");
    expect(steps.map((s) => s.tool_name ?? "").filter((c) => /adverse|engage|review|proceed/.test(c))).toEqual([]);
  });

  it("the precheck skips once the offer has an open order, and without an offer id", async () => {
    const [p] = await weft.db.all<{ id: string }>(sql`SELECT id FROM proposals WHERE command = 'screening.order'`);
    const d = await weft.executor.human.decide({ proposalId: p!.id, decision: "approve", reasonCode: null, note: null, session: { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui", keyScope: null } });
    expect(d.ok, JSON.stringify(d)).toBe(true);
    const [o] = await weft.db.all<{ status: string; offer_id: string }>(sql`SELECT status, offer_id FROM screening_orders`);
    expect(o).toEqual({ status: "invited", offer_id: offerId });
    await settleAll();
    const [rr] = await weft.db.all<{ status: string }>(sql`SELECT status FROM routine_runs WHERE routine_id = ${R.id}`);
    expect(rr!.status).toBe("done");
    const ctx = { companyId: "cmp_larkspur", now: weft.clock.now(), triggerRef: "event:test", payload: { offer_id: offerId } };
    const skip = await screeningFollowUp(ctx, readOnly());
    expect(skip).toMatchObject({ action: "skip" });
    expect((skip as { reason: string }).reason).toMatch(/already has background check scr_/);
    expect(await screeningFollowUp({ ...ctx, payload: {} }, readOnly())).toEqual({ action: "skip", reason: "The event carries no offer id." });
  });

  it("the precheck derives exactly one screening.order call for an accepted offer with no order", async () => {
    await weft.db.run(sql`DELETE FROM screening_orders`);
    const out = await screeningFollowUp({ companyId: "cmp_larkspur", now: weft.clock.now(), triggerRef: "event:test", payload: { offer_id: offerId, worker_id: "wrk_x" } }, readOnly());
    expect(out).toMatchObject({ action: "run", subjectRefs: [offerId, "wrk_x"], derivedArgs: { offer_id: offerId, "screening.order": { offer_id: offerId } } });
    expect(JSON.stringify(out)).not.toMatch(/price_cents|CR-2015-0417/);
  });
});
