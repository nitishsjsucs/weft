// Scenario s3 (SPEC 12, 13). Owner: t2-world. GP3 new hire in a new state (asserts tainted === false).
// Part 1 runs the domain flow now, through direct stand-ins for the executor (no approvals or action rows) and
// the real scheduler with the real handlers. Part 2 is the end-to-end run (HumanExecutor, rt_new_hire on the
// scripted provider with scripts/s3-new-hire.json, decisions) and runs once the executor and routines land.
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

  it.todo("runs end to end with the scripted provider, approvals and the chain check once the executor and routines land (t2-world, integrator)");
});
