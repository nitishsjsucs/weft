// Scenario GP8 (docs/wave2.md): the straggler nudge. Owner: w2-onboarding. Scripted provider; the script for
// rt_onboarding_nudge is scenarios/rt_onboarding_nudge.json, also written into a temp WEFT_SCRIPTS_DIR next to copies
// of the repo's scenarios so this test pins the exact steps. A hire signs the offer and stops; past the
// due date the routine posts one nudge in #new-hires naming the open tasks, a second run the same day is skipped by
// the precheck, and once the checklist is complete the routine skips for good.
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunRow, RoutineRun } from "@weft/contracts";
import { sql } from "drizzle-orm";
import { routines } from "@weft/db";
import { RT_ONBOARDING_NUDGE as R } from "../../packages/routines/src/wave2/onboarding";
import { createTestWeft, type TestWeft } from "./helpers";

const NUDGE = {
  agents: {
    main: [
      { output: [{ type: "function_call", name: "comms__send_message", arguments: "{{derived.comms.send_message}}" }] },
      { output: [{ type: "text", text: "Nudged the new hires with overdue onboarding tasks in #new-hires." }] },
    ],
  },
};

const CANDIDATE = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "TX", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };
const NAME = "Rowan Ellery";

describe("GP8 straggler nudge", () => {
  let weft: TestWeft;
  const scripts = mkdtempSync(join(tmpdir(), "weft-gp8-scripts-"));
  const prev = process.env.WEFT_SCRIPTS_DIR;
  beforeAll(async () => {
    const repo = join(import.meta.dirname, "../../scenarios");
    for (const f of readdirSync(repo)) if (f.endsWith(".json")) copyFileSync(join(repo, f), join(scripts, f));
    writeFileSync(join(scripts, "rt_onboarding_nudge.json"), JSON.stringify(NUDGE));
    process.env.WEFT_SCRIPTS_DIR = scripts;
    weft = await createTestWeft();
    // rt_onboarding_nudge is in PREBUILT; reading it through the engine seeds its row.
    await (weft.routines as unknown as { ensurePrebuilt(): Promise<void> }).ensurePrebuilt();
  });
  afterAll(async () => {
    // offer.accepted starts rt_new_hire in the background; run the pending events now and let every queued or
    // running run settle before closing (weft.close() does not drain them yet, a known w2-reliability item).
    await weft.scheduler.tick();
    for (let i = 0; i < 10; i++) {
      const open = await weft.db.all<{ id: string; agent_run_id: string | null }>(sql`SELECT id, agent_run_id FROM routine_runs WHERE status IN ('queued', 'running')`);
      const runs = await weft.db.all<{ id: string }>(sql`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`);
      if (!open.length && !runs.length) break;
      for (const r of runs) await (weft.agent as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
      for (const r of open) await (weft.routines as unknown as { settled(id: string): Promise<unknown> }).settled(r.id);
    }
    await weft.close();
    if (prev === undefined) delete process.env.WEFT_SCRIPTS_DIR; else process.env.WEFT_SCRIPTS_DIR = prev;
    rmSync(scripts, { recursive: true, force: true });
  });
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers: { ...weft.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const trigger = async () => {
    const { routineRunId } = (await call("usr_dana", "POST", "/v1/routines/rt_onboarding_nudge/trigger", {})).json as { routineRunId: string };
    const run = await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(routineRunId);
    if (run.agentRunId) await (weft.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(run.agentRunId);
    return (await (weft.routines as unknown as { settled(id: string): Promise<RoutineRun> }).settled(routineRunId));
  };
  const nudges = async () => ((await call("usr_dana", "GET", `/v1/sim/chat?channel=${encodeURIComponent("#new-hires")}`)).json as { text: string; author: string }[]).filter((m) => m.text.startsWith("Friendly reminder"));

  let persona = "";
  it("ships disabled with at most 8 tools and the posted:#new-hires checklist", async () => {
    const def = (await call("usr_dana", "GET", "/v1/routines/rt_onboarding_nudge")).json;
    expect(def).toMatchObject({ id: "rt_onboarding_nudge", enabled: false, trigger: { type: "cron" }, checklist: [{ check: "posted:#new-hires" }] });
    expect(def.tools.length).toBeLessThanOrEqual(8);
  });

  it("nothing to nudge before the due date", async () => {
    const offerId = (await call("usr_dana", "POST", "/v1/offers", CANDIDATE)).json.data.offer_id;
    persona = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).json.data.persona_principal_id;
    const letter = (await call(persona, "GET", "/v1/portal/me")).json.documents.find((d: { kind: string }) => d.kind === "offer_letter");
    expect((await call(persona, "POST", `/v1/portal/documents/${letter.id}/sign`, { typedName: NAME, documentSha256: letter.sha256 })).status).toBe(200);
    const run = await trigger();
    expect(run.status).toBe("skipped");
    expect(await nudges()).toEqual([]);
  });

  it("past the due date it posts one nudge naming the open tasks, once a day", async () => {
    await weft.clock.set("2026-11-03T17:00:00.000Z", 0);   // Tue 10:00 PT, a day after the start date
    const first = await trigger();
    expect(first.status).toBe("done");
    const posted = await nudges();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("Rowan Ellery");
    expect(posted[0]!.text).toContain("Federal tax withholding (Form W-4)");
    expect(posted[0]!.text).toContain("Direct deposit");
    expect(posted[0]!.text).not.toContain("State tax withholding");   // TX has no state certificate
    const again = await trigger();
    expect(again.status).toBe("skipped");
    expect(await nudges()).toHaveLength(1);
  });

  it("stops once the checklist is complete", async () => {
    const me = (await call(persona, "GET", "/v1/portal/me")).json;
    const nda = me.documents.find((d: { kind: string }) => d.kind === "confidentiality_agreement");
    expect((await call(persona, "POST", `/v1/portal/documents/${nda.id}/sign`, { typedName: NAME, documentSha256: nda.sha256 })).status).toBe(200);
    expect((await call(persona, "POST", "/v1/portal/state-withholding", { state: "TX", filingStatus: "single", allowances: 0, extraCents: 0, exempt: false, typedName: NAME })).json.code).toBe("DOMAIN_NO_STATE_FORM");
    expect((await call(persona, "POST", "/v1/portal/w4", { filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 0, exempt: false, typedName: NAME })).status).toBe(200);
    expect((await call(persona, "POST", "/v1/portal/direct-deposit", { bankName: "Tidepool Federal Credit Union", routing: "021000021", account: "5550001234", accountType: "checking", typedName: NAME })).status).toBe(200);
    const form = new FormData();
    form.set("citizenship", "citizen"); form.set("documentKind", "us_passport"); form.set("documentNumberLast4", "B9K1"); form.set("typedName", NAME);
    form.set("idImage", new Blob([Buffer.from("fake image bytes for the demo")], { type: "image/png" }), "id.png");
    expect((await weft.app.request("/v1/portal/i9", { method: "POST", headers: weft.uiHeaders(persona), body: form })).status).toBe(200);
    expect((await call(persona, "POST", "/v1/portal/benefits", { elections: [], waived: ["medical", "dental", "vision", "401k"], typedName: NAME })).status).toBe(200);
    const view = (await call(persona, "GET", "/v1/portal/me")).json;
    expect([view.done, view.total, view.workerStatus]).toEqual([6, 6, "active"]);
    await weft.clock.set("2026-11-04T17:00:00.000Z", 0);
    const run = await trigger();
    expect(run.status).toBe("skipped");
    expect(await nudges()).toHaveLength(1);
  });
});
