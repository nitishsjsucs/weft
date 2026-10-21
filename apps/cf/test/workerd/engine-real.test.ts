// Design 11.4 with the real Weft stack in workerd (scripted provider): weft-core's real entry, cf1's facade and
// snapshot code, cf2's durable platform and cf3's agent and MCP handler. These cases run once those three tracks are
// merged (deps.ts reports what is missing) and pnpm cf:snapshot has built apps/cf/generated; until then the gate case
// below names the missing parts and the rest are skipped. With the parts present, a missing snapshot fails the gate.
//
// Covered here: full restore matches the manifest; the delta reset returns the digest to the manifest twice; GP1
// (deliver DE 2088, two proposals, approve, Undo, chain valid); double approve gives one execution; GP5 taint; an
// alarm-driven run with an SSE subscriber; PROCESS_RESTART at boot; a replayed alarm executes nothing twice; a
// showcase cold start plus GET sweep writes 0 rows; ETag 304s read 0 rows; a warm tick writes 0 rows; the fetch
// counter stays at or under 40; /mcp lists 122 tools and refuses approve, rollback and vault; 4 slots in one isolate
// stay under 100 MB; no node:fs, node:child_process or node:net is reachable from the weft-core entry.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROUTES } from "../../../../packages/contracts/src/api";
import { DO_NAMES, MAX_FETCHES_PER_ALARM } from "../../src/shared/contracts";
import { missingDeps } from "../../src/core/company/deps";
import { scanImports, type Metafile } from "../../../../scripts/cf/lib/import-scan";
import { CF_DIR, Harness, ORIGIN, type Visitor } from "../support/harness";

const missing = missingDeps();
const manifestFile = join(CF_DIR, "generated/manifest.json");
const ready = missing.length === 0;

describe("real engine gate", () => {
  it(ready ? "has the snapshot the real engine restores" : `waits for ${missing.length} parts from cf1, cf2 and cf3`, () => {
    if (!ready) {
      console.log(`real-engine cases skipped until merged:\n  ${missing.join("\n  ")}`);
      expect(missing.length).toBeGreaterThan(0);
      return;
    }
    expect(existsSync(manifestFile), "run pnpm cf:snapshot first").toBe(true);
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

describe.skipIf(!ready)("real engine in workerd", () => {
  let h: Harness;
  let manifest: { digests: Record<string, { rows: number }>; extra?: { chainHead: string | null; snapshotId: string } };
  beforeAll(async () => {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as typeof manifest;
    h = await Harness.start({ engine: "real", poolSize: 4 });
    await h.provision(300_000);
  }, 360_000);
  afterAll(async () => { await h?.close(); });

  const smoke = async (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await h.smokeHeaders()) } }, { origin: null, principal: "usr_dana" });
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

  it("GP1: deliver DE 2088, two proposals, approve the rate, Undo, chain valid; a double approve executes once", async () => {
    expect((await post("/api/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
    const open = await until(pending, (ps) => ["notices.send_response", "tax.update_rate"].every((c) => ps.some((p) => p.command === c)));
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
    // A replayed alarm with nothing queued executes nothing twice.
    const before = (await smokeJson<{ count: number }>("/api/v1/actions?limit=200")).body.count;
    const co = await company(DO_NAMES.smoke);
    await co.runAlarmNow();
    await co.runAlarmNow();
    expect((await smokeJson<{ count: number }>("/api/v1/actions?limit=200")).body.count).toBe(before);
  });

  it("returns slot-smoke to the seed with the delta reset, twice, within 25% of 557 rows written", async () => {
    const lobby = async () => { const e = await env(); return e.LOBBY.get(e.LOBBY.idFromName(DO_NAMES.lobby)); };
    for (let cycle = 0; cycle < 2; cycle++) {
      await post("/api/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" });
      const open = await until(pending, (ps) => ps.some((p) => p.command === "tax.update_rate"));
      await post(`/api/v1/proposals/${open.find((p) => p.command === "tax.update_rate")!.id}/approve`, { reasonCode: null, note: null });
      const r = await (await lobby()).resetWorld({ slot: DO_NAMES.smoke });
      expect(r).toMatchObject({ ok: true, method: "delta" });
      expect((r as { rowsWritten: number }).rowsWritten).toBeLessThanOrEqual(Math.ceil(557 * 1.25));
      expect((await pending()).length).toBe(0);
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
    await h.core.evictDurableObject("CompanyDO", { name: l.slot! });
    const after = await v.json<{ status: string; terminalReason: string | null }>(`/api/v1/agent/runs/${start.body.runId}`, { headers: { "x-weft-principal": "usr_dana" } });
    expect(after.body).toMatchObject({ status: "failed", terminalReason: "PROCESS_RESTART" });
  });

  it("writes 0 rows on a showcase cold start and GET sweep, reads 0 rows on a 304, and 0 rows on a warm tick", async () => {
    await h.core.evictDurableObject("CompanyDO", { name: DO_NAMES.showcase });
    const show = await company(DO_NAMES.showcase);
    await show.heartbeat();
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

  it("serves remote MCP: 122 tools, approve, rollback and vault refused, a proposal pending approval", async () => {
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
      const rate = await client.callTool({ name: "tax__update_rate", arguments: { code: "sui", state: "CA", rate: "0.016", effective_from: "2027-01-01", source_notice_id: null } });
      expect(JSON.stringify(rate.content)).toContain("pending_approval");
    } finally {
      await client.close();
    }
  });

  it("keeps 4 worlds in one isolate under 100 MB", async () => {
    const rss = () => {
      const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
      const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([pid, ppid, kb, ...c]) => ({ pid: Number(pid), ppid: Number(ppid), kb: Number(kb), comm: c.join(" ") }));
      const mine = new Set([process.pid]);
      for (let changed = true; changed;) { changed = false; for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); changed = true; } }
      return rows.filter((r) => mine.has(r.pid) && /workerd/.test(r.comm)).reduce((n, r) => n + r.kb, 0) / 1024;
    };
    const base = rss();
    for (const slot of ["slot-1", "slot-2", "slot-3", "slot-4"]) await (await company(slot)).heartbeat();
    const visitors: Visitor[] = [];
    for (let i = 0; i < 4; i++) { const x = h.visitor(`198.51.100.${150 + i}`); await x.lease(); visitors.push(x); }
    for (const x of visitors) await x.fetch("/api/v1/workers?limit=50", { headers: { "x-weft-principal": "usr_dana" } });
    const grown = rss() - base;
    console.log(`workerd RSS ${base.toFixed(0)} MB before, +${grown.toFixed(0)} MB with 4 worlds booted`);
    expect(grown).toBeLessThan(100);
  });

  it("reaches no node:fs, node:child_process or node:net from the weft-core entry", () => {
    const out = mkdtempSync(join(tmpdir(), "weft-core-meta-"));
    try {
      execFileSync(join(CF_DIR, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out, "--metafile", join(out, "meta.json"), "-c", "wrangler.core.jsonc"], { cwd: CF_DIR, stdio: "pipe" });
      const r = scanImports(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as Metafile, (p) => p.endsWith("src/core/index.ts"));
      expect(r.reachable).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});
