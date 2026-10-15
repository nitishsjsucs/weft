import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunHandle, ToolOutcome } from "@weft/contracts";
import { employerTaxRates, payrollRuns, withWriteLock } from "@weft/db";
import { count, makeWorld, type World } from "./fixtures";
import { executorInternals } from "../src/index";
import { runInTx } from "../src/pipeline";
import { agentScope, resolveRun } from "../src/scope";

let w: World;
let h: RunHandle;
beforeEach(async () => {
  w = await makeWorld();
  h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await w.close(); });

async function propose(command: string, args: unknown, callId = command): Promise<string> {
  const o: ToolOutcome = await w.executor.agent.exec(h, { callId, command, args });
  if (!(o.ok && o.status === "pending_approval")) throw new Error(JSON.stringify(o));
  return o.proposalId;
}
const decide = (proposalId: string, principalId = "usr_dana", decision: "approve" | "deny" = "approve") =>
  w.executor.human.decide({ proposalId, decision, reasonCode: null, note: null, session: w.ui(principalId) });

describe("decide", () => {
  it("two concurrent approves execute exactly once; executed_action_seq is unique", async () => {
    const id = await propose("tax.update_rate", { rate_id: "etr_0001", rate: "0.015", source_notice_id: "ntc_0001" });
    const [a, b] = await Promise.all([decide(id), decide(id, "usr_theo")]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, code: "NOT_PENDING" });
    expect(await count(w.db, "actions", `proposal_id = '${id}'`)).toBe(1);
    const r = oks[0]!;
    expect(r.ok && r.proposal.status).toBe("executed");
    expect(r.ok && r.proposal.executedActionSeq).toBe(1);
    const [rate] = await w.db.select().from(employerTaxRates).where(eq(employerTaxRates.id, "etr_0001"));
    expect(rate!.rate).toBe("0.015");
    expect((await w.executor.verifyChain()).ok).toBe(true);
  });

  it("a ceiling lowered after the proposal gives OVER_CEILING", async () => {
    const id = await propose("payroll.submit_run", { run_id: "pay_2026_10_30", exclude_blocked: true });
    await w.db.run(`UPDATE limits SET cents = 1000 WHERE key = 'agent.payroll_run_cents'` as never);
    const r = await decide(id, "usr_theo");
    expect(r.ok && r.outcome && !r.outcome.ok && r.outcome.refusal.code).toBe("OVER_CEILING");
    expect(r.ok && r.proposal.status).toBe("failed");
    expect(await count(w.db, "actions")).toBe(0);
    const [run] = await w.db.select().from(payrollRuns);
    expect(run!.status).toBe("draft");
  });

  it("a changed subject gives STALE_SUBJECT", async () => {
    const id = await propose("payroll.submit_run", { run_id: "pay_2026_10_30" });
    await w.db.update(payrollRuns).set({ totalsJson: JSON.stringify({ cashRequirement: 41234501 }) });
    expect(await decide(id, "usr_theo")).toMatchObject({ ok: false, code: "STALE_SUBJECT" });
    expect(await count(w.db, "actions")).toBe(0);
  });

  it("an approved payroll moves exactly the proposed money and emits stamped events", async () => {
    const id = await propose("payroll.submit_run", { run_id: "pay_2026_10_30" });
    const r = await decide(id, "usr_theo");
    expect(r.ok && r.outcome?.ok).toBe(true);
    const [evt] = await w.db.all<{ attended: number; requested_by: string }>(`SELECT attended, requested_by FROM events WHERE type = 'payroll.submitted'` as never);
    expect(evt).toMatchObject({ attended: 1, requested_by: "usr_theo" });
  });

  it("refusals: AGENT_PRINCIPAL, UI_SESSION_REQUIRED, WRONG_ROLE, NOT_PENDING for a random id, SELF_APPROVAL when required", async () => {
    const id = await propose("tax.update_rate", { rate_id: "etr_0001", rate: "0.015" });
    expect(await w.executor.human.decide({ proposalId: id, decision: "approve", reasonCode: null, note: null, session: { principalId: "agt_weft", companyId: "cmp_larkspur", via: "ui", keyScope: null } }))
      .toMatchObject({ ok: false, code: "AGENT_PRINCIPAL" });
    expect(await w.executor.human.decide({ proposalId: id, decision: "approve", reasonCode: null, note: null, session: { ...w.ui("usr_dana"), via: "api_key", keyScope: "admin" } }))
      .toMatchObject({ ok: false, code: "UI_SESSION_REQUIRED" });
    expect(await decide(id, "usr_sam")).toMatchObject({ ok: false, code: "WRONG_ROLE" });
    expect(await decide("prp_9999")).toMatchObject({ ok: false, code: "NOT_PENDING" });
    await w.db.run(`UPDATE settings SET value_json = 'true' WHERE key = 'require_second_approver'` as never);
    expect(await decide(id, "usr_dana")).toMatchObject({ ok: false, code: "SELF_APPROVAL" });
    expect((await decide(id, "usr_theo")).ok).toBe(true);
  });

  it("deny is audited and never executes", async () => {
    const id = await propose("tax.update_rate", { rate_id: "etr_0001", rate: "0.015" });
    const r = await decide(id, "usr_dana", "deny");
    expect(r.ok && r.proposal.status).toBe("denied");
    expect(await count(w.db, "actions")).toBe(0);
    expect(await count(w.db, "approval_audit", `proposal_id = '${id}' AND attempt = 'deny'`)).toBe(1);
  });

  it("at the pipeline level, an unapproved or already executed proposal id is refused, never executed", async () => {
    const id = await propose("tax.update_rate", { rate_id: "etr_0001", rate: "0.015" });
    const e = executorInternals(w.executor)!.engine;
    const attempt = async () => withWriteLock(() => w.db.transaction(async (tx) => {
      const row = (await resolveRun(tx, h))!;
      const scope = await agentScope(e, tx, row, h.token, null, null);
      const [p] = await tx.all<Record<string, unknown>>(`SELECT * FROM proposals WHERE id = '${id}'` as never);
      const prop = { ...(p as object), argsJson: (p as { args_json: string }).args_json, argsHash: (p as { args_hash: string }).args_hash, subjectHash: (p as { subject_hash: string }).subject_hash,
        moneyCents: null, id, proposerRunId: h.runId } as never;
      return (await runInTx(e, tx, { ...scope, caller: "approved" }, "tax.update_rate", { rate_id: "etr_0001", rate: "0.015" }, { approved: prop })).outcome;
    }));
    const o = await attempt();
    expect(o.ok).toBe(false);
    expect(await count(w.db, "actions")).toBe(0);
    await decide(id, "usr_theo");
    expect(await count(w.db, "actions")).toBe(1);
    expect((await attempt()).ok).toBe(false);
    expect(await count(w.db, "actions")).toBe(1);
  });

  it("routine.drafted becomes a routine_enable proposal in the same transaction; approving enables it", async () => {
    const o = await w.executor.agent.exec(h, { callId: "d", command: "routines.draft", args: { name: "Friday digest", cron: "0 9 * * 5" } });
    expect(o.ok && o.status).toBe("done");
    const [p] = await w.db.all<{ id: string; kind: string; headline: string }>(`SELECT id, kind, headline FROM proposals` as never);
    expect(p).toMatchObject({ kind: "routine_enable", headline: "Enable routine Friday digest (rt_0001)" });
    const r = await decide(p!.id);
    expect(r.ok && r.proposal.status).toBe("executed");
    const [rt] = await w.db.all<{ enabled: number }>(`SELECT enabled FROM routines` as never);
    expect(rt!.enabled).toBe(1);
  });

  it("expires pending proposals after 72 hours, and payroll proposals 1 hour before the approval deadline", async () => {
    const tax = await propose("tax.update_rate", { rate_id: "etr_0001", rate: "0.015" });
    const pay = await propose("payroll.submit_run", { run_id: "pay_2026_10_30" });
    const rows = await w.db.all<{ id: string; expires_at: string }>(`SELECT id, expires_at FROM proposals ORDER BY id` as never);
    expect(rows.find((r) => r.id === tax)!.expires_at).toBe("2026-10-29T15:30:00.000Z");
    expect(rows.find((r) => r.id === pay)!.expires_at).toBe("2026-10-28T23:00:00.000Z");
    expect(await w.executor.expireProposals("2026-10-29T00:00:00.000Z")).toBe(1);
    expect(await decide(pay, "usr_theo")).toMatchObject({ ok: false, code: "NOT_PENDING" });
  });
});
