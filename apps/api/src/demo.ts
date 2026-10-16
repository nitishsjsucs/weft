// `pnpm demo` (SPEC 12): a narrated run of the golden paths GP1 to GP5 on one seeded world in .data-demo, with the
// scripted provider and a frozen sim clock (Mon 2026-10-26 08:30 PT). Every step goes through the same HTTP routes
// the UI uses, then prints what changed. The world is kept, so it can be browsed afterwards:
//   WEFT_DATA_DIR=.data-demo pnpm dev
// `pnpm demo:tests` runs the same golden paths as the scenario tests (tests/scenarios), each on a fresh world.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, proposals, routineRuns } from "@weft/db";
import { seedWorld } from "@weft/seed";
import { createWeft } from "./compose";

process.env.WEFT_LLM = "scripted";   // the demo never spends money, whatever the shell exports
const root = resolve(import.meta.dirname, "../../..");
const dataDir = resolve(root, process.env.WEFT_DEMO_DATA_DIR ?? ".data-demo");
rmSync(dataDir, { recursive: true, force: true });

const weft = await createWeft({ dataDir, testMode: true });
await seedWorld(weft);
await weft.clock.set("2026-10-26T15:30:00.000Z", 0);
const headers = (who: string) => ({ "x-weft-principal": who, "x-weft-proxy": weft.proxySecret, "content-type": "application/json" });
const call = async (method: string, path: string, body: unknown, who = "usr_dana") => {
  const res = await weft.app.request(path, { method, headers: headers(who), body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 400) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json)}`);
  return json ?? {};
};
const post = (path: string, body: unknown = {}, who?: string) => call("POST", path, body, who);
const get = (path: string, who?: string) => call("GET", path, undefined, who);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => console.log(line);
const head = (line: string) => console.log(`\n== ${line}`);

async function idle(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const busy = await weft.db.select().from(agentRuns).where(sql`${agentRuns.status} IN ('queued', 'running')`);
    if (busy.length === 0) return;
    await sleep(20);
  }
  throw new Error("agent runs did not go idle");
}
/** Ticks the scheduler until the routine has a run with an agent run, then waits for that agent run to stop. */
async function routineRun(routineId: string, after: number): Promise<{ agentRunId: string; status: string; tainted: boolean }> {
  for (let i = 0; i < 40; i++) {
    await weft.scheduler.tick();
    await idle();
    const rows = (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId))).slice(after);
    const rr = rows.find((r) => r.agentRunId);
    if (rr?.agentRunId) {
      const [run] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, rr.agentRunId));
      return { agentRunId: rr.agentRunId, status: run!.status, tainted: run!.tainted };
    }
  }
  throw new Error(`${routineId} did not start`);
}
const runsOf = async (routineId: string) => (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId))).length;
const pendingOf = (runId: string) => weft.db.select().from(proposals).where(and(eq(proposals.proposerRunId, runId), eq(proposals.status, "pending")));
async function approveAll(runId: string, who: string): Promise<void> {
  for (const p of await pendingOf(runId)) {
    await post(`/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null }, who);
    say(`   approved by ${who}: ${p.headline}`);
  }
  await idle();
}

say(`Weft demo world in ${dataDir} (scripted provider, sim clock frozen at Mon Oct 26 08:30 PT)`);

head("GP1 tax notice to rate change");
let n = await runsOf("rt_agency_notice");
const delivered = await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
say(`   delivered ${(delivered as { data?: { notice_id?: string } }).data?.notice_id ?? "a notice"} from the CA EDD simulator`);
const gp1 = await routineRun("rt_agency_notice", n);
say(`   rt_agency_notice run ${gp1.agentRunId}: ${gp1.status}, tainted ${gp1.tainted}, ${(await pendingOf(gp1.agentRunId)).length} proposals`);
await approveAll(gp1.agentRunId, "usr_dana");
const caRates = await weft.db.all<{ rate: string; source: string }>(sql`SELECT rate, source FROM employer_tax_rates WHERE jurisdiction = 'CA' AND code = 'sui' ORDER BY rowid DESC LIMIT 1`);
say(`   CA SUI rate is now ${caRates[0]?.rate} (source ${caRates[0]?.source})`);

head("GP5 ask the agent");
for (const text of ["Why is the NY raise flagged in the Oct 30 payroll?", "Approve everything in my inbox"]) {
  const { runId } = (await post("/v1/agent/runs", { text, pageContext: null })) as { runId: string };
  await idle();
  const [run] = await weft.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  say(`   Q: ${text}\n   A (${run!.status}): ${run!.summary}`);
}

head("GP2 pre-payroll review and payroll run");
n = await runsOf("rt_pre_payroll");
await post("/v1/routines/rt_pre_payroll/trigger", {});
const gp2 = await routineRun("rt_pre_payroll", n);
const pay = (await get("/v1/payrolls/pay_2026_10_30", "usr_theo")) as { status: string; anomalySummary?: { needsReview: number; ready: number } };
say(`   pay_2026_10_30: ${pay.anomalySummary?.needsReview} Needs Review, ${pay.anomalySummary?.ready} Ready; run ${gp2.agentRunId} ${gp2.status}`);
await approveAll(gp2.agentRunId, "usr_theo");
say(`   payroll is ${((await get("/v1/payrolls/pay_2026_10_30", "usr_theo")) as { status: string }).status}`);

head("GP4 routine on schedule");
n = await runsOf("rt_people_digest");
await post("/v1/sim/clock/advance", { by: "PT30M" });
const gp4 = await routineRun("rt_people_digest", n);
const digest = await weft.db.all<{ text: string }>(sql`SELECT text FROM sim_chat_messages WHERE channel = '#people-ops' ORDER BY rowid DESC LIMIT 1`);
say(`   09:00 PT digest run ${gp4.agentRunId} ${gp4.status}; #people-ops: ${digest[0]?.text ?? "(none)"}`);

head("GP3 new hire in a new state");
n = await runsOf("rt_new_hire");
const accepted = (await post("/v1/offers/offr_0001/accept")) as { data?: { worker_id?: string } };
const gp3 = await routineRun("rt_new_hire", n);
say(`   offer accepted for ${accepted.data?.worker_id}; rt_new_hire run ${gp3.agentRunId} ${gp3.status}, tainted ${gp3.tainted}`);
await approveAll(gp3.agentRunId, "usr_dana");
await post("/v1/sim/clock/advance", { by: "P2D" });
await weft.scheduler.tick();
await idle();
const co = await weft.db.all<{ id: string; status: string }>(sql`SELECT id, status FROM tax_accounts WHERE jurisdiction = 'CO' ORDER BY id`);
say(`   two business days later: ${co.map((a) => `${a.id} ${a.status}`).join(", ")}`);

head("GP2 settles");
await post("/v1/sim/clock/advance", { to: "2026-10-30T13:00:00.000Z" });
await weft.scheduler.tick();
await idle();
say(`   Fri Oct 30 06:00 PT: payroll is ${((await get("/v1/payrolls/pay_2026_10_30", "usr_theo")) as { status: string }).status}`);

head("GP5 guardrails: an injected notice");
n = await runsOf("rt_agency_notice");
await post("/v1/sim/notices/deliver", { scenario: "ca_de2088_injection" });
const inj = await routineRun("rt_agency_notice", n);
const tainted = await pendingOf(inj.agentRunId);
say(`   run ${inj.agentRunId}: ${inj.status}, tainted ${inj.tainted}; ${tainted.length} tainted proposals left in the inbox (${tainted.map((p) => p.command).join(", ")})`);

const chain = await weft.executor.verifyChain();
head(`Audit chain ${chain.ok ? "verifies" : "FAILS"}; memory head ${await weft.executor.memory.head()}`);
await idle();
await weft.close();
say(`\nBrowse this world: WEFT_DATA_DIR=${dataDir} pnpm dev`);
process.exit(chain.ok ? 0 : 1);
