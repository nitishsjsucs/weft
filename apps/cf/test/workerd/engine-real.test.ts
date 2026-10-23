// Design 11.4 with the real Weft stack in workerd (scripted provider): weft-core's real entry, cf1's facade and
// snapshot code, cf2's durable platform and cf3's agent and MCP handler. The cases are skipped only in a checkout
// with none of those three tracks merged (test/support/real-engine.ts). Once they are merged the cases always run,
// and the gate case fails on any part deps.ts reports missing, a partial merge, or no snapshot from pnpm cf:snapshot.
//
// Covered here: full restore matches the manifest; the delta reset after the ten flows of design 8.2 returns the
// world to the seed twice; GP1 (deliver DE 2088, two proposals, approve, Undo, chain valid); double approve gives one
// execution; GP5 taint; an alarm-driven run with an SSE subscriber; PROCESS_RESTART at boot; alarms replayed while a
// run is queued and after it execute nothing twice (exec_calls unchanged, one proposal per command); a
// showcase cold start plus GET sweep writes 0 rows; ETag 304s read 0 rows; a warm tick writes 0 rows; the fetch
// counter stays at or under 40; /mcp lists 122 tools and refuses approve, rollback and vault; agent_ask over /mcp
// settles through the ?wait=25 long poll while alarms run the run; the deployed cron handler sweeps and sends a due
// parked job again; the seed memory index runs from the admin route, metered and resumed; clean stamped worlds pass
// the full verify and the weekly sweep restores none of them; 4 slots in one isolate stay under 100 MB
// (engine-memory.test.ts). The import scan of the weft-core entry is import-scan.test.ts (it needs no snapshot).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { d1JobLedger, seedNamespace, type D1Like, type HostedJob } from "@weft/cf-extras";
import { ROUTES } from "../../../../packages/contracts/src/api";
import { DO_NAMES, MAX_FETCHES_PER_ALARM, type SeedIndexProgress } from "../../src/shared/contracts";
import { exportObjectKey } from "../../src/extras/queues";
import { Harness, ORIGIN } from "../support/harness";
import { MANIFEST_FILE as manifestFile, realEngine, realEngineProblems, skipReason } from "../support/real-engine";

describe("real engine gate", () => {
  it("runs the real engine once cf1, cf2 and cf3 are merged, with every part they export and the snapshot", () => {
    const skip = skipReason();
    if (skip) {
      console.log(`real-engine cases skipped: ${skip}`);
      return;
    }
    expect(realEngineProblems()).toEqual([]);
  });
});

type Proposal = { id: string; command: string; status: string; proposerRunId?: string | null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`not met in ${ms} ms: ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(250);
  }
}

describe.skipIf(!realEngine.run)("real engine in workerd", () => {
  let h: Harness;
  let manifest: { digests: Record<string, { rows: number }>; extra?: { chainHead: string | null; snapshotId: string } };
  beforeAll(async () => {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as typeof manifest;
    // One pool slot per case that leases (five), so no case waits for another's lease to end.
    h = await Harness.start({ engine: "real", poolSize: 5 });
    // Seven worlds restore in one day here (the deployed pool of 2 makes four): lift the provisioning ceiling.
    await (await h.coreEnv()).CONFIG.put("lobby.provision_rows_ceiling", "400000");
    await sleep(400);
    await h.provision(300_000);
  }, 360_000);
  afterAll(async () => { await h?.close(); });

  // Smoke calls skip RL_API (design 6.3); each still comes from its own address, as separate checks would.
  let ipSeq = 0;
  const smoke = async (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await h.smokeHeaders(new URL(path, ORIGIN).pathname, init.method ?? "GET")) } }, { origin: null, principal: "usr_dana", ip: `192.0.2.${(ipSeq++ % 200) + 20}` });
  const smokeJson = async <T>(path: string, init: RequestInit = {}) => { const r = await smoke(path, init); return { status: r.status, body: (await r.json()) as T }; };
  const post = (path: string, body: unknown) => smokeJson(path, { method: "POST", body: JSON.stringify(body) });
  const env = () => h.coreEnv();
  const company = async (slot: string) => { const e = await env(); return e.COMPANY.get(e.COMPANY.idFromName(slot)); };
  const pending = async () => (await smokeJson<{ data: Proposal[] }>("/api/v1/proposals?status=pending&limit=50")).body.data;

  it("restores every world from the bundled snapshot: counts, digests and the chain head match the manifest", async () => {
    const slots = (await h.ops()).lobby.slots;
    expect(slots.every((s) => s.state === "ready" && s.snapshot === manifest.extra?.snapshotId)).toBe(true);
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: DO_NAMES.showcase });
    for (const t of ["workers", "payroll_runs", "paychecks", "actions", "notices", "mem_objects"].filter((x) => manifest.digests[x])) {
      const [row] = await sql.exec(`SELECT COUNT(*) AS n FROM "${t}"`) as { n: number }[];
      expect(row!.n, t).toBe(manifest.digests[t]!.rows);
    }
    const chain = await smokeJson<{ ok: boolean; head: { hash: string } | null }>("/api/v1/actions/verify");
    expect(chain.body.ok).toBe(true);
    expect(chain.body.head?.hash ?? null).toBe(manifest.extra?.chainHead ?? null);
    const health = await smokeJson<{ runtime: string; seedProfile: string; world: { slot: string } }>("/api/v1/health");
    expect(health.body).toMatchObject({ runtime: "cloudflare", seedProfile: "rich", world: { slot: DO_NAMES.smoke } });
  });

  it("GP1: deliver DE 2088, two proposals, approve the rate, Undo, chain valid; a double approve executes once; replayed alarms execute nothing twice", async () => {
    const co = await company(DO_NAMES.smoke);
    const seedPending = new Set((await pending()).map((p) => p.id));
    const fresh = async () => (await pending()).filter((p) => !seedPending.has(p.id));
    expect((await post("/api/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
    // The delivery queued the routine run. Alarms are at-least-once: fire its alarm twice at once, as a retried
    // delivery may, while the run is queued or running.
    await Promise.all([co.runAlarmNow(), co.runAlarmNow()]);
    const open = await until(fresh, (ps) => ["notices.send_response", "tax.update_rate"].every((c) => ps.some((p) => p.command === c)));
    const smokeSql = await h.core.getDurableObjectStorage("CompanyDO", { name: DO_NAMES.smoke });
    const execCalls = async () => ((await smokeSql.exec(`SELECT COUNT(*) AS n FROM exec_calls`)) as { n: number }[])[0]!.n;
    const calls = await execCalls();
    expect(calls).toBeGreaterThan(0);
    // And again after the run: the replays start nothing and execute no call twice (exec_calls dedupe, design 4.3).
    await co.runAlarmNow();
    await co.runAlarmNow();
    expect(await execCalls()).toBe(calls);
    const after = await fresh();
    for (const c of ["notices.send_response", "tax.update_rate"]) expect(after.filter((p) => p.command === c), c).toHaveLength(1);
    const rate = open.find((p) => p.command === "tax.update_rate")!;
    const reply = open.find((p) => p.command === "notices.send_response")!;
    const approved = await post(`/api/v1/proposals/${rate.id}/approve`, { reasonCode: null, note: null });
    expect(approved.status).toBe(200);
    const seq = (approved.body as { outcome: { actionSeq: number } }).outcome.actionSeq;
    const undo = await post(`/api/v1/actions/${seq}/rollback`, { reason: "Miniflare GP1 undo" });
    expect(undo.status).toBe(200);
    const actions = await smokeJson<{ data: { command: string }[] }>("/api/v1/actions?limit=5&order=desc");
    expect(actions.body.data.map((a) => a.command)).toContain("tax.revert_rate");
    // Two concurrent approvals of the reply: one execution, one NOT_PENDING.
    const both = await Promise.all([0, 1].map(() => post(`/api/v1/proposals/${reply.id}/approve`, { reasonCode: null, note: null })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(both.find((r) => r.status === 422)!.body).toMatchObject({ ok: false, code: "NOT_PENDING" });
    expect((await smokeJson<{ ok: boolean }>("/api/v1/actions/verify")).body.ok).toBe(true);
  });

  it("returns slot-smoke to the seed with the delta reset after the ten flows, twice, within 25% of 557 rows written", async () => {
    const lobby = async () => { const e = await env(); return e.LOBBY.get(e.LOBBY.idFromName(DO_NAMES.lobby)); };
    const co = await company(DO_NAMES.smoke);
    // Runs start in alarm invocations: drive them until none is queued or running.
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        await co.runAlarmNow();
        const runs = (await smokeJson<{ data: { status: string }[] }>("/api/v1/agent/runs?limit=50")).body.data ?? [];
        if (!runs.some((r) => ["queued", "running"].includes(r.status))) return;
        await sleep(100);
      }
      throw new Error("runs did not settle");
    };
    // Start from the seed (the cases above changed slot-smoke), and remember the seed's pending proposals.
    expect(await (await lobby()).resetWorld({ slot: DO_NAMES.smoke })).toMatchObject({ ok: true });
    const seedPending = (await pending()).map((p) => p.id).sort();
    for (let cycle = 0; cycle < 2; cycle++) {
      // The ten flows of design 8.2 (the session cf1-db records on the emulator, packages/db/test-workerd/flows.ts).
      const status: Record<string, number> = {};
      status.deliver = (await post("/api/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status;
      await settle();
      const open = (await pending()).filter((p) => !seedPending.includes(p.id));
      const rate = open.find((p) => p.command === "tax.update_rate");
      const reply = open.find((p) => p.command === "notices.send_response");
      status.approveRate = rate ? (await post(`/api/v1/proposals/${rate.id}/approve`, { reasonCode: null, note: null })).status : 0;
      await settle();
      status.approveReply = reply ? (await post(`/api/v1/proposals/${reply.id}/approve`, { reasonCode: null, note: null })).status : 0;
      await settle();
      status.prePayroll = (await post("/api/v1/routines/rt_pre_payroll/trigger", {})).status;
      await settle();
      status.chatCost = (await post("/api/v1/agent/runs", { text: "Show payroll cost by month" })).status;
      await settle();
      status.expenses = (await post("/api/v1/routines/rt_expense_review/trigger", {})).status;
      await settle();
      status.chatTimeOff = (await post("/api/v1/agent/runs", { text: "How many hours of time off does Grace Adeyemi have left?" })).status;
      await settle();
      status.offer = (await post("/api/v1/offers/offr_0001/accept", {})).status;
      await settle();
      status.payday = (await post("/api/v1/sim/clock/advance", { to: "2026-10-30T16:00:00.000Z" })).status;
      await settle();
      let gets = 0;
      for (const r of ROUTES) if (r.method === "GET" && !r.path.includes(":") && !r.path.includes("/events")) { if ((await smoke(`/api${r.path}`)).status < 500) gets++; }
      await settle();
      for (const [flow, code] of Object.entries(status)) {
        expect(code, `${flow} in cycle ${cycle + 1}`).toBeGreaterThanOrEqual(200);
        expect(code, `${flow} in cycle ${cycle + 1}`).toBeLessThan(300);
      }
      expect(gets).toBeGreaterThan(40);
      const r = await (await lobby()).resetWorld({ slot: DO_NAMES.smoke });
      expect(r).toMatchObject({ ok: true, method: "delta" });
      console.log(`delta reset ${cycle + 1}: ${(r as { rowsWritten: number }).rowsWritten} rows written`);
      expect((r as { rowsWritten: number }).rowsWritten).toBeLessThanOrEqual(Math.ceil(557 * 1.25));
      expect((await pending()).map((p) => p.id).sort()).toEqual(seedPending);
      expect((await smokeJson<{ ok: boolean; head: { hash: string } | null }>("/api/v1/actions/verify")).body.head?.hash ?? null).toBe(manifest.extra?.chainHead ?? null);
    }
  });

  it("GP5: an injected notice taints the run and nothing R2 to R4 executes", async () => {
    await post("/api/v1/sim/reset", {});
    expect((await post("/api/v1/sim/notices/deliver", { scenario: "ca_de2088_injection" })).status).toBe(200);
    const runs = await until(async () => (await smokeJson<{ data: { id: string; status: string; tainted: boolean }[] }>("/api/v1/agent/runs?limit=10")).body.data,
      (rs) => rs.some((r) => r.tainted && !["queued", "running"].includes(r.status)));
    const run = runs.find((r) => r.tainted)!;
    const acts = await smokeJson<{ data: { command: string }[] }>(`/api/v1/actions?runId=${run.id}&limit=100`);
    expect(acts.body.data.filter((a) => ["tax.update_rate", "notices.send_response", "payroll.submit"].includes(a.command))).toEqual([]);
  });

  it("runs a chat in alarm invocations with an SSE subscriber, at most 40 counted fetches", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const start = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ text: "Show payroll cost by month", pageContext: null, threadId: null }), headers: { "x-weft-principal": "usr_dana" } });
    expect(start.status).toBeLessThan(300);
    const sse = await v.fetch(`/api/v1/agent/runs/${start.body.runId}/events`, { headers: { "x-weft-principal": "usr_dana" } });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await Promise.race([sse.text(), sleep(60_000).then(() => "")]);
    expect(text).toContain("data:");
    const fin = await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${start.body.runId}`, { headers: { "x-weft-principal": "usr_dana" } })).body, (r) => !["queued", "running"].includes(r.status));
    expect(["done", "waiting"]).toContain(fin.status);
    expect((await (await company(l.slot!)).alarmFetches()).peak).toBeLessThanOrEqual(MAX_FETCHES_PER_ALARM);
  });

  it("fails a run left running with PROCESS_RESTART when the object restarts", async () => {
    const v = h.visitor();
    const l = await v.lease();
    const start = await v.json<{ runId: string }>("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ text: "How much time off does Grace have left?", pageContext: null, threadId: null }), headers: { "x-weft-principal": "usr_dana" } });
    await until(async () => (await v.json<{ status: string }>(`/api/v1/agent/runs/${start.body.runId}`, { headers: { "x-weft-principal": "usr_dana" } })).body, (r) => !["queued", "running"].includes(r.status));
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: l.slot! });
    await sql.exec(`UPDATE agent_runs SET status = 'running', terminal_reason = NULL WHERE id = ?`, start.body.runId);
    await (await company(l.slot!)).restartWorld("Miniflare PROCESS_RESTART case");
    await sleep(500);
    const after = await v.json<{ status: string; terminalReason: string | null }>(`/api/v1/agent/runs/${start.body.runId}`, { headers: { "x-weft-principal": "usr_dana" } });
    expect(after.body).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
  });

  it("writes 0 rows on a showcase cold start and GET sweep, reads 0 rows on a 304, and 0 rows on a warm tick", async () => {
    // A cold start: restart the showcase if it is running.
    await (await company(DO_NAMES.showcase)).restartWorld("Miniflare cold start");
    await sleep(500);
    const show = await company(DO_NAMES.showcase);   // a stub to the restarted object
    expect((await show.heartbeat()).usage.rowsWritten).toBe(0);
    const v = h.visitor();
    const gets = ROUTES.filter((r) => r.method === "GET" && !r.path.includes(":") && !r.path.includes("/events"));
    for (const r of gets) await v.fetch(`/api${r.path}?sweep=1`, {}, { principal: "usr_dana" });
    const hb = await show.heartbeat();
    expect(hb.usage.rowsWritten).toBe(0);
    expect(hb.usage.requests).toBeGreaterThan(gets.length / 2);

    const lv = h.visitor();
    const l = await lv.lease();
    const first = await lv.fetch("/api/v1/proposals?status=pending", { headers: { "x-weft-principal": "usr_dana" } });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const co = await company(l.slot!);
    await co.heartbeat();
    const again = await lv.fetch("/api/v1/proposals?status=pending", { headers: { "x-weft-principal": "usr_dana", "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect((await co.heartbeat()).usage.rowsRead).toBe(0);

    await co.measureTick();
    const warm = await co.measureTick();
    expect(warm).toMatchObject({ ran: true, rowsWritten: 0 });
  });

  it("serves remote MCP: 122 tools, approve, rollback and vault refused, a payout proposal pending approval", async () => {
    const v = h.visitor();
    await v.lease();
    const { key } = await (await v.fetch("/api/_hosted/mcp-key", { method: "POST", headers: { "x-weft-principal": "usr_dana" } })).json() as { key: string };
    const client = new Client({ name: "weft-miniflare", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: ((url: string | URL, init?: RequestInit) => h.server.fetch(String(url), init as never)) as never,
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(122);
      expect(tools.some((t) => /^(proposals|actions__rollback|vault__)/.test(t.name))).toBe(false);
      const refused = await client.callTool({ name: "actions__rollback", arguments: { seq: 1, reason: "x" } });
      expect(refused.isError).toBe(true);
      // docs/demo-scenarios.md scenario 8, call 6: a propose tool files a proposal that waits for a person.
      const payouts = await client.callTool({ name: "contractors__schedule_payouts", arguments: { worker_ids: ["wrk_0049", "wrk_0050", "wrk_0051"], scheduled_for: "2026-10-30" } });
      expect(JSON.stringify(payouts.content)).toContain("pending_approval");
    } finally {
      await client.close();
    }
  });

  it("answers agent_ask over /mcp: the run settles in alarm invocations while GET /v1/agent/runs/:id?wait=25 waits", async () => {
    const v = h.visitor();
    const l = await v.lease();
    expect(l.status).toBe("leased");
    const { key } = await (await v.fetch("/api/_hosted/mcp-key", { method: "POST", headers: { "x-weft-principal": "usr_dana" } })).json() as { key: string };
    const client = new Client({ name: "weft-miniflare", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: ((url: string | URL, init?: RequestInit) => h.server.fetch(String(url), init as never)) as never,
    });
    await client.connect(transport);
    try {
      const t0 = Date.now();
      const r = await client.callTool({ name: "agent_ask", arguments: { question: "Show payroll cost by month" } });
      const text = (r.content as { type: string; text: string }[])[0]!.text;
      expect(r.isError, text).toBeFalsy();
      const run = JSON.parse(text) as { id: string; status: string };
      // A settled run, not the "still running" answer after the third request.
      expect(["done", "waiting"]).toContain(run.status);
      expect(run.id).toMatch(/^run_/);
      // Within the POST and two long polls of 25 s.
      expect(Date.now() - t0).toBeLessThan(55_000);
      const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: l.slot! });
      const [row] = (await sql.exec(`SELECT status FROM agent_runs WHERE id = ?`, run.id)) as { status: string }[];
      expect(row!.status).toBe(run.status);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("reads an uploaded receipt through weft-jobs: one write-back action, none on a redelivery, nothing but the two write-backs as svc_jobs", async () => {
    // cf6-extras end to end on the real stack: expenses.submit appends an outbox row in its transaction, CompanyDO sends
    // it after the commit, the weft-jobs consumer reads the receipt (the fakes worker stands in for Workers AI) and
    // writes the extract back through CompanyDO.extrasWriteBack, which runs the executor's svc_jobs system path.
    const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: DO_NAMES.smoke });
    const count = async (q: string, ...b: unknown[]) => Number(((await sql.exec(q, ...b)) as { n: number }[])[0]!.n);
    const actionsBefore = await count("SELECT count(*) AS n FROM actions");
    const form = new FormData();
    for (const [k, v] of Object.entries({ workerId: "wrk_0025", category: "meals", merchant: "Fake Cafe (demo)", amountCents: "1062", transactionDate: "2026-10-20", businessPurpose: "Team lunch" })) form.set(k, v);
    form.set("receipt", new Blob([PNG], { type: "image/png" }), "lunch.png");
    // The multipart body as bytes with its boundary and length, as a browser sends it (the front needs a Content-Length).
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const res = await smoke("/api/v1/expenses", { method: "POST", body: bytes, headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(bytes.byteLength) } });
    const body = (await res.json()) as { data: { expense_id: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    const id = body.data.expense_id;
    const row = await until(async () => ((await sql.exec("SELECT receipt_extract_json AS j, receipt_upload_id AS upl FROM expenses WHERE id = ?", id)) as { j: string | null; upl: string }[])[0]!, (r) => !!r.j, 60_000);
    const extract = JSON.parse(row.j!) as { source: string; merchant: string | null; read: boolean; ocrJobId: string };
    expect(extract).toMatchObject({ source: "ocr", merchant: "Fake Cafe (demo)", read: true });
    expect(extract.ocrJobId).toMatch(/^obx_[0-9a-f]{16}$/);
    const writeBacks = () => count("SELECT count(*) AS n FROM actions WHERE command = 'expenses.attach_receipt_extract'");
    expect(await writeBacks()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM outbox")).toBe(0);
    // The same job again, through the slot port: refused before any write, so it settles as "already" with no new row.
    const co = await company(DO_NAMES.smoke);
    const args = { job_id: extract.ocrJobId, expense_id: id, upload_id: row.upl, extract: null, model: "@cf/mistralai/mistral-small-3.1-24b-instruct", neurons: 0 };
    expect(await co.extrasWriteBack({ command: "expenses.attach_receipt_extract", args } as never)).toEqual({ ok: true, status: "already", reason: null });
    expect(await co.extrasWriteBack({ command: "payroll.submit_run", args: {} } as never)).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    expect(await writeBacks()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM actions")).toBe(actionsBefore + 2);   // expenses.submit and its one write-back
    expect((await smokeJson<{ ok: boolean }>("/api/v1/actions/verify")).body.ok).toBe(true);
  }, 120_000);

  it("runs weft-core's deployed cron handler: the Lobby sweep, then a parked job that is due goes back to its queue and runs", async () => {
    const e = await env();
    const ledger = d1JobLedger(e.OPS as unknown as D1Like);
    const gen = (await h.ops()).lobby.slots.find((s) => s.name === DO_NAMES.smoke)!.gen;
    // A job a daily share refused yesterday, parked until a minute ago (the queue consumer parks such jobs).
    const job: HostedJob = { v: 1, kind: "export.world", jobId: `obx_${"c".repeat(12)}${Date.now().toString(16).slice(-4)}`, slot: DO_NAMES.smoke, gen, what: "world", requestedBy: "usr_dana" };
    await ledger.defer(job, new Date(Date.now() - 60_000).toISOString(), "share");
    const sweptBefore = ((await h.ops()).lobby.readout as unknown as { lastSweepAt: string | null }).lastSweepAt;
    // src/core/index.ts's scheduled(): coreHandler's Lobby sweep, then extrasCron with the JOBS and RENDER producers.
    const r = await h.core.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date() });
    expect(r.outcome).toBe("ok");
    const rec = await until(() => ledger.get(job.jobId), (x) => x?.state === "done", 60_000);
    expect(rec).toMatchObject({ state: "done", outcome: "stored" });
    expect(await e.FILES!.head(exportObjectKey(job))).toBeTruthy();
    const swept = await until(async () => ((await h.ops()).lobby.readout as unknown as { lastSweepAt: string | null }).lastSweepAt, (at) => !!at && at !== sweptBefore);
    expect(Date.parse(swept!)).toBeGreaterThan(Date.now() - 120_000);
  }, 120_000);

  it("runs the design 11.3 conformance cases on the scratch conformance object (the deployed route), which wipes itself", async () => {
    const r = await h.admin("POST", "/api/_admin/conformance", {});
    expect(r.status).toBe(200);
    const out = (await r.json()) as { passed: number; failed: number; skipped: number; cases: { name: string; ok: boolean; skipped?: boolean; detail?: string }[] };
    expect(out.cases.filter((c) => !c.ok)).toEqual([]);
    // Only the hang-and-reset case is left out: it resets the object it runs on (Miniflare and the emulator cover it).
    expect(out.cases.filter((c) => c.skipped).map((c) => c.name)).toEqual(["raw linear begin and commit hangs and resets"]);
    expect(out.passed).toBe(out.cases.length - 1);
    const sql = await h.core.getDurableObjectStorage("CompanyDO", { name: DO_NAMES.conformance });
    expect(await sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")).toEqual([]);
  }, 120_000);

  it("indexes the snapshot's memory notes from the admin route, metered by SpendDO's embeddings share and resumed by the Lobby", async () => {
    const e = await env();
    const spend = e.SPEND.get(e.SPEND.idFromName(DO_NAMES.spend));
    const used = async () => (await spend.status({})).neurons.byProduct.embeddings;
    const before = await used();
    const step = async () => { const r = await h.admin("POST", "/api/_admin/seed-index", {}); expect(r.status).toBe(200); return (await r.json()) as SeedIndexProgress; };
    const first = await step();
    const snapshot = manifest.extra!.snapshotId;
    expect(first).toMatchObject({ snapshot, namespace: seedNamespace(snapshot), from: 0, ran: true });
    expect(first.notes).toBeGreaterThan(20);
    expect(first.chunks).toBeGreaterThan(first.notes - 1);
    // Every batch went through the embeddings share: it paid for some, and never past the day's 200 neurons.
    const after = await used();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(200);
    // The vectors are in the shared seed namespace, at generation 0 (every world restored from the snapshot reads them).
    const found = await (e.MEMVEC as unknown as { query(v: number[], o: { namespace: string; topK: number }): Promise<{ matches: { metadata?: { gen?: number; path?: string } }[] }> })
      .query(new Array(768).fill(0.5), { namespace: seedNamespace(snapshot), topK: 5 });
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches.every((m) => m.metadata?.gen === 0 && /\.md$/.test(m.metadata?.path ?? ""))).toBe(true);
    // The next step starts where this one stopped; today's share is spent, so it indexes nothing more today.
    const second = await step();
    if (first.nextChunk === null) {
      expect(second).toMatchObject({ done: true, ran: false, nextChunk: null });
    } else {
      expect(first.nextChunk).toBeGreaterThan(0);
      expect(second).toMatchObject({ from: first.nextChunk, nextChunk: first.nextChunk, done: false, ran: true });
      expect(await used()).toBe(after);
    }
  }, 120_000);

  it("verifies clean stamped worlds against the manifest (kv_state, the stamp's table, left out), and the weekly sweep restores none", async () => {
    const e = await env();
    const lobby = e.LOBBY.get(e.LOBBY.idFromName(DO_NAMES.lobby));
    // slot-smoke after a reset (the delta reset, then its new stamp in kv_state); the showcase stamped at provisioning.
    expect(await lobby.resetWorld({ slot: DO_NAMES.smoke })).toMatchObject({ ok: true });
    for (const name of [DO_NAMES.showcase, DO_NAMES.smoke]) {
      const v = await (await company(name)).verifyWorld();
      expect(v, name).toMatchObject({ ok: true, skipped: false, mismatches: [] });
      expect(v.rows, name).toBeGreaterThan(5_000);
    }
    const before = (await h.ops()).lobby.slots;
    // Eight days on: every lease has ended and its world is reset, and every idle world is due its weekly full verify.
    const r = await lobby.sweep({ now: Date.now() + 8 * 86_400_000 });
    expect(r.restores).toEqual([]);
    const after = (await h.ops()).lobby.slots;
    for (const name of [DO_NAMES.showcase, DO_NAMES.smoke]) {
      const b = before.find((s) => s.name === name)!, a = after.find((s) => s.name === name)!;
      expect(a, name).toMatchObject({ state: "ready", gen: b.gen, error: null });
    }
    expect(after.filter((s) => s.state !== "ready")).toEqual([]);
  }, 180_000);
});
