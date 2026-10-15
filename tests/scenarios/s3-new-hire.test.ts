// Scenario s3 (SPEC 12, 13). Owner: t2-world. GP3 new hire in a new state (asserts tainted === false).
// Part 1 runs the domain flow through direct stand-ins for the executor (no approvals or action rows) and the real
// scheduler with the real handlers. Part 2 is the end-to-end run through the real executor and skips while the
// executor is a stub (checked against track/t3-governance in a scratch merge on 2026-10-15).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { commands, directExecutors, findCommand, handlers, nonEmptyUntrusted } from "@weft/core";
import { createScheduler } from "@weft/api";
import type { ExecutorBundle, RoutinesEngine, ToolOutcome } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "./helpers";

const NOOR_OFFER = "offr_0001";
const CO_ACCOUNTS = ["txa_0006", "txa_0007"];
const RT_NEW_HIRE = ["people.get", "onboarding.get_checklist", "tax.list_registrations", "tax.register_state_account", "it.create_account", "it.order_device", "onboarding.complete_task", "comms.send_message"];

describe("GP3 new hire in a new state (asserts tainted === false)", () => {
  let weft: TestWeft;
  let tainted = false;
  const seen: string[] = [];
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });

  it("the rt_new_hire allowlist cannot taint in the concise format", () => {
    for (const name of RT_NEW_HIRE) {
      const def = findCommand(name);
      const concisePaths = def.untrustedFields;
      expect(concisePaths.length === 0 || def.effect === "read", name).toBe(true);
    }
  });

  it("runs the domain flow: accept, accounts, welcome, registrations, activation, state_registration done", async () => {
    const d = directExecutors(weft.db, weft.clock, weft.sims);
    const dana = d.human("usr_dana");
    const track = (name: string, o: ToolOutcome) => {
      seen.push(name);
      if (o.ok && o.status === "done") tainted ||= nonEmptyUntrusted(findCommand(name), o.data).length > 0;
      return o;
    };
    const done = <T>(o: ToolOutcome): T => { if (!o.ok) throw new Error(JSON.stringify(o.refusal)); expect(o.status).toBe("done"); return (o as { data: T }).data; };

    const accepted = done<{ worker_id: string; employee_number: string }>(track("people.accept_offer", await dana.exec("people.accept_offer", { offer_id: NOOR_OFFER })));
    const noor = accepted.worker_id;
    expect(accepted.employee_number).toBe("EMP-0049");
    const evt = await weft.db.all<{ payload_json: string; attended: number }>(sql`SELECT payload_json, attended FROM events WHERE type = 'offer.accepted'`);
    expect(evt.map((e) => JSON.parse(e.payload_json))).toEqual([{ offer_id: NOOR_OFFER, worker_id: noor }]);

    const agent = d.human("agt_weft", "agent");   // the agent's executable calls, untainted main agent
    const person = done<{ worker: Record<string, unknown> }>(track("people.get", await agent.exec("people.get", { worker_id: noor })));
    expect(person.worker).toMatchObject({ name: `Noor Castellanos (demo) (${noor})`, status: "onboarding", work_state: "CO", bank_account: { status: "active", source: "demo_bundle" }, w4: { filing_status: "single", source: "demo_bundle" } });
    const checklist = done<{ tasks: { kind: string; status: string }[] }>(track("onboarding.get_checklist", await agent.exec("onboarding.get_checklist", { worker_id: noor })));
    expect(checklist.tasks.filter((t) => t.status === "pending").map((t) => t.kind)).toEqual(["i9_sim", "benefits_selection", "it_accounts", "device", "state_registration"]);
    const regs = done<{ by_state: Record<string, string> }>(track("tax.list_registrations", await agent.exec("tax.list_registrations", { jurisdiction: "CO" })));
    expect(regs.by_state).toEqual({ CO: "incomplete" });

    for (const system of ["chat", "google_ws", "github"]) track("it.create_account", await agent.exec("it.create_account", { worker_id: noor, system }));
    track("comms.send_message", await agent.exec("comms.send_message", { channel: "#new-hires", text: "Please welcome our new Senior Firmware Engineer joining the Hardware team in Colorado. Say hello here!" }));
    // Proposals in the real flow; Dana approves, so here they run as Dana.
    for (const id of CO_ACCOUNTS) done(track("tax.register_state_account", await dana.exec("tax.register_state_account", { tax_account_id: id })));
    const device = done<{ price_cents: number }>(track("it.order_device", await dana.exec("it.order_device", { worker_id: noor })));
    expect(device.price_cents).toBe(189_900);

    const accounts = await weft.db.all<{ system: string; handle: string }>(sql`SELECT system, handle FROM it_accounts WHERE worker_id = ${noor} ORDER BY system`);
    expect(accounts).toEqual([{ system: "chat", handle: "noor.castellanos" }, { system: "github", handle: "lrk-noor-castellanos" }, { system: "google_ws", handle: "noor.castellanos" }]);
    const welcome = await weft.sims.chat.list("#new-hires");
    expect(welcome.at(-1)).toMatchObject({ author: "Weft agent", inbound: false });
    const co = await weft.db.all<{ status: string }>(sql`SELECT status FROM tax_accounts WHERE jurisdiction = 'CO' ORDER BY id`);
    expect(co.map((r) => r.status)).toEqual(["awaiting_state", "awaiting_state"]);

    const bundle = { ...(weft.executor as object), system: d.system, readOnly: d.readOnly, expireProposals: async () => 0, redact: (t: string) => t } as unknown as ExecutorBundle;
    const routines = { tick: async () => undefined, trigger: async () => ({ routineRunId: "rtr_none" }), onProposalDecided: async () => undefined } as RoutinesEngine;
    const scheduler = createScheduler({ db: weft.db, clock: weft.clock, sims: weft.sims, executor: bundle, handlers, routines, log: () => undefined });

    await weft.clock.advance("2026-10-27T15:30:00.000Z");
    await scheduler.tick();
    expect((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tax_accounts WHERE jurisdiction = 'CO' AND status = 'active'`))[0]!.n).toBe(0);
    await weft.clock.advance("2026-10-28T15:30:00.000Z");   // 2 business days after Mon 08:30 PT
    await scheduler.tick();
    await scheduler.stop();

    const after = await weft.db.all<{ agency: string; status: string; account_number: string }>(sql`SELECT agency, status, account_number FROM tax_accounts WHERE jurisdiction = 'CO' ORDER BY id`);
    expect(after.map((a) => a.status)).toEqual(["active", "active"]);
    expect(after.every((a) => /^00\d{6}$/.test(a.account_number))).toBe(true);
    const rates = await weft.db.all<{ code: string; rate: string; wage_base_cents: number; source: string }>(sql`SELECT code, rate, wage_base_cents, source FROM employer_tax_rates WHERE jurisdiction = 'CO'`);
    expect(rates).toEqual([{ code: "sui", rate: "0.0305", wage_base_cents: 3_060_000, source: expect.stringMatching(/^registration:sima_\d{4}$/) }]);
    const confirmed = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM notices WHERE kind = 'registration_confirmed'`);
    expect(confirmed[0]!.n).toBe(2);
    const task = await weft.db.all<{ kind: string; status: string }>(sql`SELECT kind, status FROM onboarding_tasks WHERE worker_id = ${noor} ORDER BY id`);
    expect(Object.fromEntries(task.map((t) => [t.kind, t.status]))).toMatchObject({ state_registration: "done", it_accounts: "done", device: "done" });
    const activated = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM events WHERE type = 'tax_account.activated'`);
    expect(activated[0]!.n).toBe(2);
    await weft.clock.advance("2026-10-29T15:30:00.000Z");   // laptop ETA: 3 business days after the order
    const s2 = createScheduler({ db: weft.db, clock: weft.clock, sims: weft.sims, executor: bundle, handlers, routines, log: () => undefined });
    await s2.tick();
    await s2.stop();
    const dev = await weft.db.all<{ status: string; price_cents: number }>(sql`SELECT status, price_cents FROM devices WHERE worker_id = ${noor}`);
    expect(dev).toEqual([{ status: "delivered", price_cents: 189_900 }]);

    // Noor's Nov 1 to 15 preview has no block flag once T1's draft commands land.
    if (commands.some((c) => c.name === "payroll.create_draft")) {
      const out = await dana.exec("payroll.create_draft", { pay_schedule_id: "ps_us_semimonthly", period_end: "2026-11-15" });
      expect(out.ok).toBe(true);
      const flags = await weft.db.all<{ flags_json: string }>(sql`SELECT flags_json FROM paychecks WHERE worker_id = ${noor}`);
      expect(flags.length).toBeGreaterThan(0);
      for (const f of flags) expect((JSON.parse(f.flags_json) as { severity: string }[]).some((x) => x.severity === "block")).toBe(false);
    }
    expect(seen).toEqual(expect.arrayContaining(RT_NEW_HIRE.filter((n) => n !== "onboarding.complete_task")));
    expect(tainted).toBe(false);
  });

});

// Part 2 runs only when the real executor is wired (it is a stub on the track branch). It drives the calls of
// scripts/s3-new-hire.json through executor.agent in a routine run, as the agent loop will once T4 lands, with
// "Mark accepted" through the HumanExecutor route, Dana's decisions, the sim clock route, the chain and memory checks.
interface ScriptCall { type: string; name?: string; arguments?: Record<string, unknown> }
interface ScriptStep { expect?: { lastResults: { tool: string; ok?: boolean; status?: string }[] }; output: ScriptCall[]; stop: boolean }
const script = JSON.parse(readFileSync(join(import.meta.dirname, "scripts", "s3-new-hire.json"), "utf8")) as { routine: string; agents: { main: ScriptStep[] } };
const fill = (v: unknown, workerId: string): unknown => JSON.parse(JSON.stringify(v).replaceAll("{{trigger.worker_id}}", workerId));
const toCommand = (tool: string) => tool.replace("__", ".");

describe("GP3 end to end through the executor (asserts tainted === false)", () => {
  let weft: TestWeft;
  beforeAll(async () => { weft = await createTestWeft(); });
  afterAll(async () => { await weft.close(); });
  const live = () => !weft.stubs.includes("executor");

  it("Mark accepted, rt_new_hire calls, Dana approves, 2 business days activate CO and complete state_registration", async (ctx) => {
    if (!live()) return ctx.skip();
    const post = async (path: string, body?: unknown) => {
      const res = await weft.app.request(path, { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.status, path).toBe(200);
      return res.json() as Promise<ToolOutcome>;
    };
    const accepted = await post(`/v1/offers/${NOOR_OFFER}/accept`);
    if (!accepted.ok || accepted.status !== "done") throw new Error(JSON.stringify(accepted));
    const noor = (accepted.data as { worker_id: string }).worker_id;
    const [evt] = await weft.db.all<{ id: string }>(sql`SELECT id FROM events WHERE type = 'offer.accepted'`);

    const routineRunId = "rtr_s3_0001";
    const open = () => weft.executor.runs.openRoutineRun({ routineId: script.routine, routineRunId, triggerRef: evt!.id, attended: true });
    const run = await open().catch(async () => {
      await weft.db.run(sql`INSERT INTO routines (id, company_id, name, description, owner_principal_id, enabled, trigger_json, instructions, tools_json, budget_json, surface_json, source, created_at)
        VALUES (${script.routine}, 'cmp_larkspur', 'New hire (demo)', 's3', 'usr_dana', 1, '{"type":"event","event":"offer.accepted"}', '', ${JSON.stringify(RT_NEW_HIRE)}, '{}', '{}', 'prebuilt', ${weft.clock.now()})`);
      return open();
    });

    let tainted = false;
    let last: { tool: string; outcome: ToolOutcome }[] = [];
    let n = 0;
    for (const [i, step] of script.agents.main.entries()) {
      for (const [j, want] of (step.expect?.lastResults ?? []).entries()) {
        const got = last[j]!;
        expect(got.tool, `step ${i} result ${j}`).toBe(want.tool);
        if (want.ok !== undefined) expect(got.outcome.ok, `${want.tool} ${JSON.stringify(got.outcome)}`).toBe(want.ok);
        if (want.status) expect(got.outcome.ok && got.outcome.status, `${want.tool} ${JSON.stringify(got.outcome)}`).toBe(want.status);
      }
      last = [];
      for (const c of step.output.filter((o) => o.type === "function_call")) {
        const outcome = await weft.executor.agent.exec(run, { callId: `call_s3_${++n}`, command: toCommand(c.name!), args: fill(c.arguments, noor), batch: i + 1 } as never);
        tainted ||= outcome.tainted;
        last.push({ tool: c.name!, outcome });
      }
      if (step.stop) break;
    }

    const pending = await weft.db.all<{ id: string; command: string; tainted_by: string | null }>(sql`SELECT id, command, tainted_by FROM proposals WHERE status = 'pending' ORDER BY id`);
    expect(pending.map((p) => p.command)).toEqual(["tax.register_state_account", "tax.register_state_account", "it.order_device"]);
    expect(pending.every((p) => p.tainted_by === null)).toBe(true);
    const session = { principalId: "usr_dana", companyId: "cmp_larkspur", via: "ui" as const, keyScope: null };
    for (const p of pending) {
      const d = await weft.executor.human.decide({ proposalId: p.id, decision: "approve", reasonCode: null, note: null, session });
      if (!d.ok) throw new Error(`${p.command}: ${d.code} ${d.message}`);
      expect(d.outcome?.ok && d.outcome.status, p.command).toBe("done");
    }

    await post("/v1/sim/clock/advance", { by: "P2D" });   // Mon 08:30 PT plus 2 business days
    const co = await weft.db.all<{ status: string }>(sql`SELECT status FROM tax_accounts WHERE id IN ('txa_0006', 'txa_0007') ORDER BY id`);
    expect(co.map((r) => r.status)).toEqual(["active", "active"]);
    const rates = await weft.db.all<{ code: string; rate: string; source: string }>(sql`SELECT code, rate, source FROM employer_tax_rates WHERE jurisdiction = 'CO'`);
    expect(rates).toEqual([{ code: "sui", rate: "0.0305", source: expect.stringMatching(/^registration:sima_\d{4}$/) }]);
    const tasks = await weft.db.all<{ kind: string; status: string }>(sql`SELECT kind, status FROM onboarding_tasks WHERE worker_id = ${noor}`);
    expect(Object.fromEntries(tasks.map((t) => [t.kind, t.status]))).toMatchObject({ state_registration: "done", it_accounts: "done", device: "done" });
    const byHandler = await weft.db.all<{ actor_id: string }>(sql`SELECT actor_id FROM actions WHERE command = 'onboarding.complete_task'`);
    expect(byHandler.map((a) => a.actor_id)).toEqual(["svc_events"]);
    const device = await weft.db.all<{ price_cents: number }>(sql`SELECT price_cents FROM devices WHERE worker_id = ${noor}`);
    expect(device).toEqual([{ price_cents: 189_900 }]);

    expect(await weft.executor.verifyChain()).toMatchObject({ ok: true, gaps: [], badSeq: null });
    expect(await weft.executor.memory.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(tainted).toBe(false);
  });
});
