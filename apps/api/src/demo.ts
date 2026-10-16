// `pnpm demo` (SPEC 12, docs/wave2.md, docs/wave3.md): a narrated run of the golden paths GP1 to GP18 on one seeded world in
// .data-demo, with the scripted provider and a frozen sim clock (Mon 2026-10-26 08:30 PT). Every step goes through the
// same HTTP routes the UI, the portal and MCP clients use, then prints what changed. The one exception is the GP10
// fixture (a mid-period raise written straight into pay_rates, as the scenario test does). The world is kept, so it
// can be browsed afterwards:
//   WEFT_DATA_DIR=.data-demo pnpm dev
// `pnpm demo:tests` runs the same golden paths as the scenario tests (tests/scenarios), each on a fresh world.
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns, memoryRecalls, payRates, proposals, routineRuns } from "@weft/db";
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
/** An MCP client with the seeded demo key (an agent caller: consequential writes come back as proposals). */
const viaKey = async (path: string, body: unknown) => {
  const key = readFileSync(join(dataDir, "demo-mcp-key.txt"), "utf8").trim();
  const res = await weft.app.request(path, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 400) throw new Error(`POST ${path} (MCP key) answered ${res.status}: ${JSON.stringify(json)}`);
  return json ?? {};
};
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

// Wave 2 (docs/wave2.md): GP11, GP6, GP7, GP8, GP10, GP9 and GP12 on the same world, from Fri Oct 30.
const offerFor = async (c: Record<string, unknown>) => {
  const offerId = ((await post("/v1/offers", c)) as { data: { offer_id: string } }).data.offer_id;
  const sent = ((await post(`/v1/offers/${offerId}/send`)) as { data: { persona_principal_id: string; reserved_worker_id: string } }).data;
  return { offerId, persona: sent.persona_principal_id, workerId: sent.reserved_worker_id };
};
type PortalView = { done: number; total: number; workerStatus: string; documents: { id: string; kind: string; sha256: string }[]; plans: { id: string; type: string; name: string }[] };
const portal = async (persona: string) => (await get("/v1/portal/me", persona)) as unknown as PortalView;
const sign = async (persona: string, name: string, kinds: string[]) => {
  for (const d of (await portal(persona)).documents.filter((x) => kinds.includes(x.kind))) await post(`/v1/portal/documents/${d.id}/sign`, { typedName: name, documentSha256: d.sha256 }, persona);
};

head("GP11 benefits reconciliation, open enrollment and contractor payouts");
const recon = (await post("/v1/benefits/reconciliation/run", { month: "2026-10" })) as { data: { count: number; invoice_lines: number } };
const findings = (await get("/v1/benefits/reconciliation?month=2026-10")) as unknown as { id: string; kind: string; billedCents: number; expectedCents: number; deductedCents: number }[];
say(`   October carrier invoice: ${recon.data.invoice_lines} lines, ${recon.data.count} findings`);
for (const f of findings) say(`   ${f.kind}: billed ${f.billedCents}, expected ${f.expectedCents}, deducted ${f.deductedCents} cents`);
const dispute = (await viaKey("/v1/tools/benefits__dispute_finding", { finding_id: findings[0]!.id })) as { status: string; proposalId: string };
await post(`/v1/proposals/${dispute.proposalId}/approve`, { reasonCode: null, note: null });
const disputeMail = (await get("/v1/sim/email")) as unknown as { kind: string; to: string }[];
say(`   an MCP agent's dispute was a proposal (${dispute.status}); Dana approved it and the email simulator holds ${disputeMail.filter((m) => m.to.startsWith("billing@")).length} message to the carrier`);
n = await runsOf("rt_open_enrollment");
await post("/v1/routines/rt_open_enrollment/trigger", {});
const oe = await routineRun("rt_open_enrollment", n);
const general = await weft.db.all<{ text: string }>(sql`SELECT text FROM sim_chat_messages WHERE channel = '#general' ORDER BY rowid DESC LIMIT 1`);
say(`   rt_open_enrollment run ${oe.agentRunId} ${oe.status}; #general: ${(general[0]?.text ?? "(none)").slice(0, 120)}...`);
const payouts = (await viaKey("/v1/tools/contractors__schedule_payouts", { worker_ids: ["wrk_0049", "wrk_0050", "wrk_0051"], scheduled_for: "2026-10-30" })) as { proposalId: string };
await post(`/v1/proposals/${payouts.proposalId}/approve`, { reasonCode: null, note: null });
const railNow = async () => ((await get("/v1/contractors/payouts")) as { data: { currency: string; usdCents: number; railStatus: string }[] }).data;
say(`   contractor payouts approved: ${(await railNow()).map((p) => `${p.currency} to ${p.usdCents} USD cents ${p.railStatus}`).join(", ")}`);

head("GP6 offer to signed");
const ROWAN = { candidateFirst: "Rowan", candidateLast: "Ellery", candidateEmail: "rowan.ellery@candidate.example", title: "Firmware Test Engineer", departmentId: "dpt_hardware", workState: "CO", baseCents: 13_200_000, payKind: "salary", startDate: "2026-11-02" };
const rowan = await offerFor(ROWAN);
const invites = ((await get("/v1/sim/email")) as unknown as { kind: string; to: string; body: string }[]).filter((m) => m.to === ROWAN.candidateEmail);
say(`   offer ${rowan.offerId} sent; invite in the email simulator: ${invites.map((m) => m.kind).join(", ")} with a /portal?as=${rowan.persona} link`);
await post("/v1/portal/offer/view", {}, rowan.persona);
await sign(rowan.persona, "Rowan Ellery", ["offer_letter", "confidentiality_agreement"]);
const sigs = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM signatures WHERE signer_principal_id = ${rowan.persona}`);
const rowanOffer = (await get(`/v1/offers/${rowan.offerId}`)) as { status: string; workerId: string };
say(`   ${sigs[0]?.n} signatures with signer, sim time and sha256; offer ${rowanOffer.status}; worker ${rowanOffer.workerId} is ${(await portal(rowan.persona)).workerStatus}`);

head("GP7 new-hire checklist unblocks payroll");
await post("/v1/portal/w4", { filingStatus: "single", step2Checkbox: false, step3Cents: 0, step4aCents: 0, step4bCents: 0, step4cCents: 5_000, exempt: false, typedName: "Rowan Ellery" }, rowan.persona);
await post("/v1/portal/state-withholding", { state: "CO", filingStatus: "single", allowances: 0, extraCents: 0, exempt: false, typedName: "Rowan Ellery" }, rowan.persona);
const badAba = await weft.app.request("/v1/portal/direct-deposit", { method: "POST", headers: headers(rowan.persona), body: JSON.stringify({ bankName: "Sim Federal Credit Union", routing: "021000022", account: "4417390056", accountType: "checking", typedName: "Rowan Ellery" }) });
say(`   a routing number that fails the ABA checksum: ${badAba.status} ${((await badAba.json()) as { code: string }).code}`);
const dd = (await post("/v1/portal/direct-deposit", { bankName: "Sim Federal Credit Union", routing: "021000021", account: "4417390056", accountType: "checking", typedName: "Rowan Ellery" }, rowan.persona)) as { data: { account_last4: string; verification: string } };
say(`   direct deposit ${dd.data.verification} by the bank simulator; stored as last 4 ${dd.data.account_last4} only`);
const i9 = new FormData();
i9.set("citizenship", "citizen"); i9.set("documentKind", "us_passport"); i9.set("documentNumberLast4", "A7Q2"); i9.set("expiresOn", "2031-04-30"); i9.set("typedName", "Rowan Ellery");
i9.set("idImage", new Blob([Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")], { type: "image/png" }), "rowan-passport.png");
const i9res = await weft.app.request("/v1/portal/i9", { method: "POST", headers: { "x-weft-principal": rowan.persona, "x-weft-proxy": weft.proxySecret }, body: i9 });
say(`   I-9 image stored under the data dir; the response shows ${((await i9res.json()) as { data: { upload: { fileName: string } } }).data.upload.fileName}`);
const plans = (await portal(rowan.persona)).plans;
await post("/v1/portal/benefits", { elections: [{ planId: plans.find((p) => p.name.includes("PPO"))!.id, tier: "ee", deferralBps: null }, { planId: plans.find((p) => p.type === "dental")!.id, tier: "ee", deferralBps: null }, { planId: plans.find((p) => p.type === "401k")!.id, tier: null, deferralBps: 500 }], waived: ["vision"], typedName: "Rowan Ellery" }, rowan.persona);
const done7 = await portal(rowan.persona);
say(`   checklist ${done7.done} of ${done7.total}; worker ${rowan.workerId} is ${done7.workerStatus}`);
const novDraft = (await post("/v1/payrolls/drafts", { payScheduleId: "ps_us_semimonthly", periodEnd: "2026-11-15" })) as { data: { run_id: string } };
const [rowanPay] = await weft.db.all<{ gross_cents: number; flags_json: string; deductions_json: string }>(sql`SELECT gross_cents, flags_json, deductions_json FROM paychecks WHERE payroll_run_id = ${novDraft.data.run_id} AND worker_id = ${rowan.workerId}`);
const rowanFlags = (JSON.parse(rowanPay?.flags_json ?? "[]") as { rule: string }[]).map((f) => f.rule);
say(`   draft ${novDraft.data.run_id} pays Rowan ${rowanPay?.gross_cents} cents gross with ${(JSON.parse(rowanPay?.deductions_json ?? "[]") as unknown[]).length} pre-tax deductions; MISSING_BANK_ACCOUNT ${rowanFlags.includes("MISSING_BANK_ACCOUNT") ? "flagged" : "not flagged"}`);

head("GP8 straggler nudge (part 1)");
const TESSA = { candidateFirst: "Tessa", candidateLast: "Varga", candidateEmail: "tessa.varga@candidate.example", title: "Support Engineer", departmentId: "dpt_hardware", workState: "TX", baseCents: 9_800_000, payKind: "salary", startDate: "2026-11-02" };
const tessa = await offerFor(TESSA);
await sign(tessa.persona, "Tessa Varga", ["offer_letter"]);
n = await runsOf("rt_onboarding_nudge");
await post("/v1/routines/rt_onboarding_nudge/trigger", {});
await idle();
const early = (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_onboarding_nudge"))).slice(n);
say(`   Tessa signed the offer and stopped; before the due date rt_onboarding_nudge is ${early.map((r) => r.status).join(", ")}: ${early[0]?.summary ?? ""}`);

head("GP10 off-cycle pay");
// Fixture, as in the scenario test: Hollis Grey's paycheck was held out of the Oct 1 to 15 run, so that period was
// really missed, and his raise from $76,000.00 to $82,000.00 took effect Oct 6, mid-period.
const [oct15] = await weft.db.all<{ id: string }>(sql`SELECT id FROM payroll_runs WHERE subtype = 'regular' AND period_start = '2026-10-01' AND period_end = '2026-10-15'`);
await weft.db.run(sql`UPDATE paychecks SET status = 'excluded' WHERE payroll_run_id = ${oct15!.id} AND worker_id = 'wrk_0042'`);
await weft.db.run(sql`DELETE FROM ytd_ledger WHERE worker_id = 'wrk_0042' AND source = ${`payroll:${oct15!.id}`}`);
const [hollis] = await weft.db.all<{ id: string }>(sql`SELECT id FROM pay_rates WHERE worker_id = 'wrk_0042' AND effective_to IS NULL`);
await weft.db.run(sql`UPDATE pay_rates SET effective_to = '2026-10-05' WHERE id = ${hollis!.id}`);
await weft.db.insert(payRates).values({ id: "prt_9001", workerId: "wrk_0042", kind: "salary", amountCents: 8_200_000, currency: "USD", effectiveFrom: "2026-10-06", effectiveTo: null, createdActionSeq: null });
const oc = (await viaKey("/v1/tools/payroll.propose_off_cycle", { worker_ids: ["wrk_0042"], period_start: "2026-10-01", period_end: "2026-10-15", payday: "2026-10-27", reason: "missed_payroll", bonus_cents: { wrk_0042: 150_000 } })) as { proposalId: string };
const ocProposal = (await get(`/v1/proposals/${oc.proposalId}`)) as { headline: string; diff: { label: string; after: string }[] };
say(`   proposal: ${ocProposal.headline}`);
for (const d of ocProposal.diff.filter((x) => /Salary|Bonus/.test(x.label))) say(`   ${d.label}: ${d.after}`);
await post(`/v1/proposals/${oc.proposalId}/approve`, { reasonCode: null, note: null });
await weft.scheduler.tick();
const ocRun = await weft.db.all<{ id: string; status: string }>(sql`SELECT id, status FROM payroll_runs WHERE subtype = 'off_cycle'`);
say(`   approved: ${ocRun.map((r) => `${r.id} ${r.status}`).join(", ")} through the bank simulator`);

head("GP9 termination with access revocation");
await post("/v1/tools/it.create_account", { worker_id: "wrk_0004", system: "sso" });
const term = (await post("/v1/workers/wrk_0004/terminate", { kind: "voluntary", lastDay: "2026-10-30", reasonNote: "Moving abroad", payUnusedPto: true })) as { data: { case_id: string } };
const caseId = term.data.case_id;
type Case = { status: string; steps: { kind: string; status: string; proposalId: string | null }[] };
let ofb = (await get(`/v1/offboarding/${caseId}`)) as unknown as Case;
say(`   case ${caseId}: ${ofb.steps.map((x) => `${x.kind} ${x.status}`).join(", ")}`);
for (const step of ofb.steps.filter((x) => x.status === "proposed" && x.proposalId)) {
  await post(`/v1/proposals/${step.proposalId}/approve`, { reasonCode: null, note: null });
  say(`   approved ${step.kind}`);
}
ofb = (await get(`/v1/offboarding/${caseId}`)) as unknown as Case;
for (const step of ofb.steps.filter((x) => x.status === "pending")) await post("/v1/tools/offboarding.run_step", { case_id: caseId, step: step.kind });
ofb = (await get(`/v1/offboarding/${caseId}`)) as unknown as Case;
const imani = await weft.db.all<{ status: string; end_date: string }>(sql`SELECT status, end_date FROM workers WHERE id = 'wrk_0004'`);
const cobra = ((await get("/v1/sim/email")) as unknown as { kind: string }[]).filter((m) => m.kind === "cobra_notice").length;
say(`   case ${ofb.status}; worker ${imani[0]?.status} with end date ${imani[0]?.end_date}; ${cobra} COBRA notice in the email simulator`);

head("GP11 payouts land and GP8 nudge (part 2), Tue Nov 3 10:00 PT");
await post("/v1/sim/clock/advance", { to: "2026-11-03T17:00:00.000Z" });
await weft.scheduler.tick();
await idle();
say(`   payouts: ${(await railNow()).map((p) => `${p.currency} ${p.railStatus}`).join(", ")}`);
// The scripted run posts the first derived nudge; each later run that day takes the next overdue hire, and the
// precheck skips once every overdue hire was nudged today (a live model posts every nudge in one run).
for (let i = 0; i < 4; i++) {
  n = await runsOf("rt_onboarding_nudge");
  await post("/v1/routines/rt_onboarding_nudge/trigger", {});
  await idle();
  const [rr] = (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_onboarding_nudge"))).slice(n);
  if (rr?.agentRunId) await routineRun("rt_onboarding_nudge", n);
  const [last] = await weft.db.all<{ text: string }>(sql`SELECT text FROM sim_chat_messages WHERE channel = '#new-hires' ORDER BY rowid DESC LIMIT 1`);
  say(rr?.status === "skipped" ? `   rt_onboarding_nudge skipped: ${rr.summary}` : `   rt_onboarding_nudge ${rr?.agentRunId} done; #new-hires: ${(last?.text ?? "(none)").slice(0, 110)}...`);
  if (rr?.status === "skipped") break;
}

head("GP12 memory recall and coarsening");
n = await runsOf("rt_memory_digest");
await post("/v1/routines/rt_memory_digest/trigger", {});
await idle();
const dig = (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_memory_digest"))).slice(n);
say(`   rt_memory_digest (no model, zero tokens): ${dig[0]?.summary ?? "(no run)"}`);
const { runId: recallRun } = (await post("/v1/agent/runs", { text: "What changed for Imani Ferreira?", pageContext: null })) as { runId: string };
await idle();
const recalls = await weft.db.select().from(memoryRecalls).where(eq(memoryRecalls.runId, recallRun));
say(`   chat run ${recallRun} started with ${recalls.length} recall block logged in memory_recalls`);

// Wave 3 (docs/wave3.md): GP13 to GP18 on the same world, from Tue Nov 3 10:00 PT. GP19 (the top bar) is a browser
// check only (e2e/site-topbar.spec.ts). Workday runs last, since a first sync makes it the owner of People,
// Compensation and Time off.
head("GP13 expense review to reimbursement");
type Bands = { bands: Record<string, number> };
say(`   bands: ${Object.entries(((await get("/v1/expenses")) as unknown as Bands).bands).map(([k, v]) => `${k} ${v}`).join(", ")}`);
n = await runsOf("rt_expense_review");
await post("/v1/routines/rt_expense_review/trigger", {});
const er = await routineRun("rt_expense_review", n);
const decides = (await pendingOf(er.agentRunId)).filter((p) => p.command === "expenses.decide");
const decisionOf = (p: { argsJson: string | null }) => JSON.parse(p.argsJson ?? "{}") as { expense_id: string; decision: string; reason_code?: string };
say(`   rt_expense_review run ${er.agentRunId} ${er.status}: ${decides.length} single-item proposals (${decides.map((p) => `${decisionOf(p).expense_id} ${decisionOf(p).decision}`).join(", ")})`);
const bulk = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM actions WHERE command = 'expenses.decide'`);
say(`   nothing decided yet: ${bulk[0]?.n ?? 0} expenses.decide actions`);
for (const id of ["exp_0001", "exp_0006"]) {
  const p = decides.find((x) => decisionOf(x).expense_id === id);
  if (!p) continue;
  await post(`/v1/proposals/${p.id}/approve`, { reasonCode: null, note: null });
  const [e] = await weft.db.all<{ status: string; payroll_run_id: string | null; amount_cents: number }>(sql`SELECT status, payroll_run_id, amount_cents FROM expenses WHERE id = ${id}`);
  say(`   Dana approved ${id}: ${e?.status} on ${e?.payroll_run_id ?? "(no draft)"} for ${e?.amount_cents} cents, outside gross`);
}

head("GP14 time off with a coverage conflict");
type TimeOffReq = { status: string; approverPrincipalId: string; checks: { rule: string; severity: string }[] };
const ruth = (await get("/v1/time-off/requests/tor_0003", "usr_sam")) as unknown as TimeOffReq;
say(`   Ruth's request ${ruth.status}, routed to ${ruth.approverPrincipalId}; checks ${ruth.checks.map((c) => `${c.rule} (${c.severity})`).join(", ")}`);
type Bal = { policyId: string; usedMinutes: number; availableMinutes: number };
const vac = async () => ((await get("/v1/time-off/balances?workerId=wrk_0010&asOf=2026-11-30", "usr_sam")) as unknown as Bal[]).find((b) => b.policyId === "top_vac_us");
const vac0 = await vac();
// Imani left in GP9, so the HR manager decides; the decide command re-checks the role on the server.
await post("/v1/time-off/requests/tor_0003/decide", { decision: "approve", note: "Covered with the holiday week" }, "usr_sam");
const vac1 = await vac();
say(`   Sam approved it: vacation used ${vac0?.usedMinutes} to ${vac1?.usedMinutes} minutes, available ${vac1?.availableMinutes} minutes`);
const imaniPay = await weft.db.all<{ gross_cents: number; earnings_json: string }>(sql`SELECT gross_cents, earnings_json FROM paychecks WHERE worker_id = 'wrk_0004' AND payroll_run_id IN (SELECT id FROM payroll_runs WHERE subtype != 'regular')`);
const ptoLine = imaniPay.flatMap((p) => JSON.parse(p.earnings_json) as { type: string; hoursX100?: number; amountCents?: number }[]).find((l) => l.type === "pto_payout");
say(`   GP9 final pay comes from the ledger: ${ptoLine ? `${((ptoLine.hoursX100 ?? 0) / 100).toFixed(2)} h, ${ptoLine.amountCents} cents` : "(no PTO payout line)"}`);

head("GP15 chart answer");
const { runId: chartRun } = (await post("/v1/agent/runs", { text: "Show payroll cost by month", pageContext: null })) as { runId: string };
await idle();
type TraceStep = { kind: string; toolName: string | null; outcome: string | null; result: unknown };
const chartTrace = (await get(`/v1/agent/runs/${chartRun}/trace`)) as unknown as { steps: TraceStep[] };
const rq = chartTrace.steps.find((s) => s.toolName === "reports__query");
const rqData = (rq?.result as { outcome?: { data?: { metric: string; chart: { kind: string }; rows: unknown[] } } } | undefined)?.outcome?.data;
say(`   chat run ${chartRun}: reports.query ${rq?.outcome} -> ${rqData?.metric} as a ${rqData?.chart.kind} chart with ${rqData?.rows.length} rows`);
const agentSettings = (await get("/v1/settings/agent")) as Record<string, unknown>;
say(`   agent settings: ${JSON.stringify(agentSettings).slice(0, 160)}`);

head("GP16 routine parity");
n = await runsOf("rt_new_hire_ready");
await post("/v1/routines/rt_new_hire_ready/trigger", {});
await idle();
const ready = (await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_new_hire_ready"))).slice(n);
say(`   rt_new_hire_ready: ${ready.map((r) => `${r.status} ${r.summary ?? ""}`.trim()).join("; ").slice(0, 200)}`);
const forms = (await post("/v1/tools/contractors.list_tax_forms", {})) as { data: { contractors: { name: string; state: string }[] } };
say(`   contractor tax forms: ${forms.data.contractors.map((f) => `${f.name} ${f.state}`).join(", ")}`);

head("GP18 background check after acceptance");
const sc = (await viaKey("/v1/tools/screening__order", { offer_id: rowan.offerId, package_slug: null })) as { status: string; proposalId: string };
say(`   an MCP agent's screening.order is a proposal (${sc.status})`);
await post(`/v1/proposals/${sc.proposalId}/approve`, { reasonCode: null, note: null });
const [order] = await weft.db.all<{ id: string; status: string; price_cents: number; vendor: string; mode: string }>(sql`SELECT id, status, price_cents, vendor, mode FROM screening_orders ORDER BY id DESC LIMIT 1`);
say(`   Dana approved: order ${order?.id} ${order?.status} with ${order?.vendor} (${order?.mode}) at ${order?.price_cents} cents from the package row`);
await post("/v1/portal/screening/consent", { orderId: order!.id, typedName: "Rowan Ellery" }, rowan.persona);
await post("/v1/sim/clock/advance", { to: "2026-11-03T18:00:00.000Z" });
await weft.scheduler.tick();
await post("/v1/sim/clock/advance", { to: "2026-11-04T18:00:00.000Z" });
await weft.scheduler.tick();
await idle();
const done18 = (await get(`/v1/screening/orders/${order!.id}`)) as { status: string; result: string | null };
const bg = await weft.db.all<{ status: string }>(sql`SELECT status FROM onboarding_tasks WHERE worker_id = ${rowan.workerId} AND kind = 'background_check'`);
say(`   after consent and one business day on the sim clock: ${done18.status} (${done18.result}); background_check task ${bg[0]?.status ?? "(none)"}`);

head("GP17 Greenhouse hire to Weft offer, then Workday sync");
const gh = (await post("/v1/integrations/greenhouse/simulate", { kind: "hire" })) as { data?: { applicationId?: string } };
await idle();
const ghLinks = await weft.db.all<{ weft_id: string }>(sql`SELECT weft_id FROM ext_links WHERE vendor = 'greenhouse' AND weft_type = 'offer'`);
const ghOffer = ghLinks[0] ? ((await get(`/v1/offers/${ghLinks[0].weft_id}`)) as { status: string; candidateFirst: string; candidateLast: string }) : null;
say(`   simulated hire ${gh.data?.applicationId ?? ""}: signed delivery verified, ${ghLinks.length} linked offer (${ghOffer ? `${ghOffer.candidateFirst} ${ghOffer.candidateLast}, ${ghOffer.status}` : "none"})`);
const again = (await post("/v1/integrations/greenhouse/simulate", { kind: "redeliver" })) as Record<string, unknown>;
const ghLinks2 = await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ext_links WHERE vendor = 'greenhouse' AND weft_type = 'offer'`);
say(`   a redelivery of the same id is a no-op: still ${ghLinks2[0]?.n} linked offer (${JSON.stringify(again).slice(0, 80)})`);
const wd = (await post("/v1/integrations/workday/sync")) as { data: { detected: string[]; applied: { linked?: unknown[] } } };
say(`   Workday first sync: ${wd.data.detected.length} workers detected, ${wd.data.applied.linked?.length ?? 0} linked by work email`);
await post("/v1/integrations/workday/simulate", { kind: "worker_change" });
const wd2 = (await post("/v1/integrations/workday/sync")) as { data: { detected: string[]; applied: { applied?: { field: string }[]; sync_item_ids?: string[] } } };
say(`   one Workday change: ${wd2.data.detected.length} worker, applied ${(wd2.data.applied.applied ?? []).map((a) => a.field).join(", ") || "nothing"}, ${(wd2.data.applied.sync_item_ids ?? []).length} human-only conflict`);
const owner = (await get("/v1/integrations/workday")) as { ownership?: Record<string, string> };
say(`   Workday now owns ${Object.entries(owner.ownership ?? {}).filter(([, v]) => v === "vendor").map(([k]) => k).join(", ")}`);

const chain = await weft.executor.verifyChain();
head(`Audit chain ${chain.ok ? "verifies" : "FAILS"}; memory head ${await weft.executor.memory.head()}`);
await idle();
await weft.close();
say(`\nBrowse this world: WEFT_DATA_DIR=${dataDir} pnpm dev`);
process.exit(chain.ok ? 0 : 1);
