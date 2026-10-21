// CompanyDO (design 3.1 to 3.4, 4.6, 5.3, 6.1 to 6.4): one world per SQLite Durable Object. "showcase" is the
// read-only world unleased visitors see, "slot-1..N" are leased worlds, "slot-smoke" is the deployed smoke's world
// (scripted provider only) and "conformance" is the deployed conformance scratch object.
//
// The object gates every request on the HMAC'd x-weft-ctx the front Worker sets (never on anything the client
// names), answers 409 LEASE_ENDED to a cookie generation older than the world's, refuses mutations on the showcase,
// keeps the visitor's last activity in memory for the Lobby, feeds commits to hibernatable WebSockets, runs agent
// jobs and scheduler ticks inside alarm invocations, flushes the after-commit outbox to Queues, and runs the reset and
// restore steps the Lobby and ReseedWorkflow drive. The Weft stack itself sits behind the EngineModule seam
// (engine.ts) and is imported lazily inside blockConcurrencyWhile, so an unprovisioned object never evaluates it.
import { DurableObject } from "cloudflare:workers";
import {
  HOSTED_SETTINGS, MAX_FETCHES_PER_ALARM, MCP_AGENT_ASK_PER_KEY_DAY, QUEUES, queueFor, TRUST_HEADERS,
  DO_NAMES, type DurableStorageLike, type HostedJob, type HostedProviderId, type LiveMessage, type ModelSwitchBody, type WeftCtx, type WorldMode,
} from "../../shared/contracts";
import { envConfig } from "../../shared/config";
import { mcpKeyId, readCtx } from "../../shared/tokens";
import { stringEnv, type CoreEnv } from "../../shared/env";
import { hostedError, isMutation, json, plainError, readJson } from "../../shared/http";
import { logError, logEvent } from "../../shared/log";
import { DO_PATHS, HEALTH_PATH, isModelAdmission, LEASE_HEADER, SIM_RESET_PATH } from "../../shared/routes";
import { configEnv, liveEnv } from "./company-do-env";
import { spendClient } from "../spend/client";
import { AlarmPlan } from "./alarms";
import { loadEngine, type EngineModule, type RestoreTrigger, type WorldEngine } from "./engine";
import { countFetchesIn, installCountedFetch, rawFetch } from "./fetch-scope";
import { durableRunHost, durableSchedulerHost, fetchCounter, type DurableRunHost, type DurableSchedulerHost } from "./hosts";
import { zeroUsage, type ResetOutcome, type RestoreBeginInput, type RestoreFinish, type RestoreVerify, type SlotHeartbeat, type UsageDelta, type WorldStamp } from "./rpc";
import { addLeaseKey, hasKvState, leaseKeys, modeOf, readStamp, writeStamp } from "./world-state";

// Every global fetch an alarm invocation makes counts against its MAX_FETCHES_PER_ALARM (fetch-scope.ts).
installCountedFetch();

/** Usage is pushed to the Lobby once any of these is reached (and the rest at each heartbeat). */
const PUSH_AT = { rowsWritten: 1_000, rowsRead: 100_000, requests: 500 } as const;
/** How long a clean check, a reset or a restore waits for mutations already in flight (an MCP agent_ask long-polls). */
export const QUIESCE_MS = 10_000;
const RESTORE_KEY = "weft.restore";
const SNAPSHOT_KEY = "weft.snapshot";

interface RestoreProgress { slot: string; gen: number; mode: WorldMode; next: number; rowsWritten: number; triggers: RestoreTrigger[] }
interface RestoreDone { slot: string; gen: number; rowsWritten: number }
const RESTORE_DONE_KEY = "weft.restore_done";

export class CompanyDO extends DurableObject<CoreEnv> {
  private stamp: WorldStamp | null = null;
  private engine: WorldEngine | null = null;
  private module: EngineModule | null = null;
  private bootError: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private config = new Map<string, string | null>();
  private lastActivity: number | null = null;
  private usage: UsageDelta = zeroUsage();
  private flushing = false;
  private readonly alarms: AlarmPlan;
  private readonly counter = fetchCounter(MAX_FETCHES_PER_ALARM);
  private runHost: DurableRunHost;
  private scheduler: DurableSchedulerHost;
  /** Mutations past the gate and not yet answered, and the resets waiting for them (see quiesce). */
  private inflight = 0;
  private quiescing = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.alarms = new AlarmPlan({ setAlarm: (t) => ctx.storage.setAlarm(t), getAlarm: () => ctx.storage.getAlarm() });
    this.runHost = this.newRunHost();
    this.scheduler = this.newScheduler();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(() => this.boot());
  }

  /** The object's own name (idFromName), where the runtime reports it: an RPC naming another world is refused. */
  private assertName(slot: string): void {
    const name = (this.ctx.id as { name?: string }).name;
    if (name && name !== slot) throw new Error(`this object is ${name}, not ${slot}`);
  }

  private get storage(): DurableStorageLike {
    return this.ctx.storage as unknown as DurableStorageLike;
  }

  private newRunHost(): DurableRunHost {
    return durableRunHost({ arm: () => this.alarms.arm("runs"), counter: this.counter });
  }
  private newScheduler(): DurableSchedulerHost {
    return durableSchedulerHost({ arm: (at) => this.alarms.arm("tick", at), cancel: () => this.alarms.cancel("tick") });
  }

  /** Cold start: read the stamp with plain SQL, then boot the world if there is one (a cold start is a process restart). */
  private async boot(): Promise<void> {
    if (this.ctx.storage.kv.get<RestoreProgress>(RESTORE_KEY)) return;   // mid-restore: ReseedWorkflow drives it
    this.stamp = readStamp(this.ctx.storage.sql);
    if (!this.stamp) return;
    await this.startEngine();
  }

  private async startEngine(): Promise<void> {
    if (!this.stamp) return;
    const stamp = this.stamp;
    try {
      this.module = await loadEngine();
      this.config = await envConfig(this.env);
      this.runHost = this.newRunHost();
      this.scheduler = this.newScheduler();
      const base = stringEnv(this.env);
      const engine = await this.module.boot({
        storage: this.storage,
        env: liveEnv(base, () => configEnv(this.config, stamp.mode)),
        world: { slot: stamp.slot, gen: stamp.gen, mode: stamp.mode },
        spend: spendClient({
          stub: () => this.env.SPEND.get(this.env.SPEND.idFromName(DO_NAMES.spend)),
          world: () => `${this.stamp?.slot ?? stamp.slot}:gen-${this.stamp?.gen ?? stamp.gen}`,
          charge: () => ({ visitor: this.stamp?.visitor ?? null, ipHash: this.stamp?.ipHash ?? null }),
          guard: () => this.engine?.guard ?? null,
        }),
        runHost: this.runHost,
        schedulerHost: this.scheduler,
        onOutbox: () => queueMicrotask(() => void this.flushOutbox()),
        readOnly: stamp.mode === "showcase",
        fetch: this.counter.wrap(rawFetch),
        mcpAskAllowed: async (apiKey) => {
          const keyId = await mcpKeyId(apiKey);
          const r = await this.env.LOBBY.get(this.env.LOBBY.idFromName(DO_NAMES.lobby)).take({ key: `mcp_ask:${keyId}`, limit: MCP_AGENT_ASK_PER_KEY_DAY });
          return r.ok;
        },
      });
      this.engine = engine;
      this.bootError = null;
      // What the boot itself read and wrote counts too (design 4.4: a cold start on a restored snapshot writes 0 rows).
      const booted = engine.meter.totals();
      this.usage.rowsRead += booted.rowsRead;
      this.usage.rowsWritten += booted.rowsWritten;
      for (const k of leaseKeys(this.ctx.storage.sql)) engine.addSecret(k);
      this.unsubscribe = engine.meter.onCommit((c) => this.broadcast({ type: "commit", seq: c.seq, tables: c.tables }));
      logEvent("world.boot", { slot: stamp.slot, gen: stamp.gen, outcome: "ok" });
      await this.flushOutbox();
    } catch (e) {
      this.engine = null;
      this.bootError = e instanceof Error ? e.message : String(e);
      logError("world.boot", e, { slot: stamp.slot, gen: stamp.gen });
    }
  }

  private async stopEngine(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.alarms.cancel("runs");
    this.alarms.cancel("tick");
    if (!engine) return;
    try {
      await engine.close();
    } catch (e) {
      logError("world.close", e, { slot: this.stamp?.slot });
    }
  }

  // Requests ---------------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    this.usage.requests += 1;
    const url = new URL(request.url);
    const checked = await readCtx(this.env.WEFT_CTX_SECRET ?? "", request.headers.get(TRUST_HEADERS.ctx));
    if (!checked.ok) return hostedError("SESSION_INVALID", "This request did not come through Weft's front door");
    const c = checked.claims;
    const stamp = this.stamp;
    if (!stamp || !this.engine) {
      const restoring = !!this.ctx.storage.kv.get(RESTORE_KEY);
      return plainError(503, "NotImplemented", restoring ? "WORLD_REBUILDING" : "WORLD_NOT_READY",
        restoring ? "This demo company is being rebuilt; try again in a minute" : this.bootError ? "This demo company failed to start" : "This demo company is not provisioned yet");
    }
    const refused = this.gate(c, stamp, request.method, url.pathname);
    if (refused) return refused;
    // A mutation is counted from here (no await since the gate) until it is answered, so a clean check or a reset
    // sees every row it writes; while one of those runs, new mutations wait outside.
    const counted = isMutation(request.method);
    if (counted && this.quiescing) return plainError(503, "NotImplemented", "WORLD_REBUILDING", "This demo company is being reset; try again in a moment");
    if (counted) this.inflight += 1;
    if (c.visitor && c.visitor === stamp.visitor) this.lastActivity = Date.now();

    try {
      this.config = await envConfig(this.env);
      if (url.pathname === DO_PATHS.live) return this.acceptLive(request, stamp);
      if (url.pathname === DO_PATHS.mcp) return await this.serveMcp(request);
      if (url.pathname === DO_PATHS.model) return await this.switchModel(request, stamp);
      if (url.pathname === DO_PATHS.mcpKey) return await this.mintKey(request, stamp);
      if (url.pathname === SIM_RESET_PATH) return hostedError("HOSTED_RESET_PROFILE", "Hosted resets go through the lobby (POST /api/v1/sim/reset)");
      if (isModelAdmission(request.method, url.pathname) && c.visitor) {
        const rl = await this.env.RL_RUN.limit({ key: `run:${c.visitor}` });
        if (!rl.success) return hostedError("RATE_LIMITED", "Too many agent runs in a minute; try again shortly", { retryAfterS: 60 });
      }
      return await this.serveApp(request, url, stamp);
    } finally {
      if (counted) this.leave();
      this.scheduler.poke();
      this.maybePushUsage();
    }
  }

  private leave(): void {
    this.inflight -= 1;
    if (this.inflight <= 0) {
      this.inflight = 0;
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  /**
   * Runs a clean check, a reset or a restore once the mutations already past the gate are answered (at most
   * QUIESCE_MS), refusing new ones meanwhile (503 WORLD_REBUILDING), so a write that was in flight when a lease
   * ended is either seen by the clean check and reset, or refused; it never lands in the next generation.
   */
  private async quiesce<T>(fn: () => Promise<T>): Promise<T> {
    this.quiescing += 1;
    try {
      if (this.inflight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, QUIESCE_MS);
          this.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      return await fn();
    } finally {
      this.quiescing -= 1;
    }
  }

  /** The DO's own gate (the front checks the same things first; design 6.1 and 6.4). */
  private gate(c: WeftCtx, stamp: WorldStamp, method: string, path: string): Response | null {
    const ended = () => hostedError("LEASE_ENDED", "This demo company's lease has ended", { headers: { [LEASE_HEADER]: "ended" } });
    if (c.slot !== stamp.slot) return ended();
    switch (stamp.mode) {
      case "showcase":
        if (isMutation(method) && path !== DO_PATHS.mcp) return hostedError("WORLD_READ_ONLY", "The shared demo company is read-only; start your own demo company to make changes");
        if (path === DO_PATHS.mcp || path === DO_PATHS.live) return hostedError("LEASE_REQUIRED", "Start your own demo company first");
        return null;
      case "slot":
        if (c.gen !== stamp.gen) return ended();
        if (path === DO_PATHS.mcp) return null;   // MCP keys carry no visitor; the generation and the key hash gate them
        if (!c.visitor || c.visitor !== stamp.visitor) return ended();
        return null;
      case "smoke":
        return c.smoke ? null : hostedError("LEASE_REQUIRED", "slot-smoke serves the deployed smoke only");
      case "conformance":
        return plainError(403, "Forbidden", "CONFORMANCE_ONLY", "The conformance object answers the admin route only");
    }
  }

  private async serveApp(request: Request, url: URL, stamp: WorldStamp): Promise<Response> {
    const engine = this.engine!;
    const headers = new Headers(request.headers);
    headers.delete(TRUST_HEADERS.ctx);
    headers.delete(TRUST_HEADERS.smoke);
    const inner = new Request(request.url, { method: request.method, headers, body: request.body, redirect: "manual", ...(request.body ? { duplex: "half" } : {}) } as RequestInit);
    const { value: res, usage } = await engine.meter.measure(() => engine.fetch(inner));
    this.usage.rowsRead += usage.rowsRead;
    this.usage.rowsWritten += usage.rowsWritten;
    if (url.pathname === HEALTH_PATH && res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const body = (await res.json()) as Record<string, unknown>;
      return json({ ...body, runtime: "cloudflare", world: { slot: stamp.slot, gen: stamp.gen, mode: stamp.mode } }, { status: res.status });
    }
    return res;
  }

  private acceptLive(request: Request, stamp: WorldStamp): Response {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return plainError(426, "ValidationError", "UPGRADE_REQUIRED", "Expected a WebSocket upgrade");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`g${stamp.gen}`]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private broadcast(msg: LiveMessage, tag?: string): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  private closeSockets(msg: LiveMessage, keepGen: number | null): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (keepGen !== null && this.ctx.getTags(ws).includes(`g${keepGen}`)) continue;
      try { ws.send(JSON.stringify(msg)); ws.close(4001, msg.type === "lease" ? `lease ${msg.state}` : "closing"); } catch { /* gone */ }
    }
  }

  override async webSocketMessage(): Promise<void> {
    // The client sends nothing (pings use the auto-response); anything else is ignored.
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "closed"); } catch { /* already closed */ }
  }

  private async serveMcp(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? request.headers.get("x-api-key") ?? "";
    if (!key) return plainError(401, "Unauthorized", "MCP_KEY_REQUIRED", "An MCP key is required");
    const engine = this.engine!;
    const { value: res, usage } = await engine.meter.measure(() => engine.mcp(request));
    this.usage.rowsRead += usage.rowsRead;
    this.usage.rowsWritten += usage.rowsWritten;
    return res;
  }

  private async switchModel(request: Request, stamp: WorldStamp): Promise<Response> {
    if (request.method !== "PUT") return plainError(405, "ValidationError", "METHOD", "PUT a ModelSwitchBody");
    if (stamp.mode === "showcase") return hostedError("WORLD_READ_ONLY", "The shared demo company is read-only");
    const body = await readJson<ModelSwitchBody>(request);
    const allowed: (HostedProviderId | null)[] = ["openai", "workers_ai", "scripted", null];
    if (!body || !allowed.includes(body.provider ?? null)) return plainError(400, "ValidationError", "PROVIDER", "provider is openai, workers_ai, scripted or null");
    await this.engine!.setWorldProvider({ provider: body.provider ?? null, principalId: request.headers.get("x-weft-principal") });
    return json({ ok: true, provider: body.provider ?? null });
  }

  private async mintKey(request: Request, stamp: WorldStamp): Promise<Response> {
    if (request.method !== "POST") return plainError(405, "ValidationError", "METHOD", "POST to mint the lease's MCP key");
    if (stamp.mode !== "slot") return hostedError("LEASE_REQUIRED", "MCP keys belong to a leased demo company");
    const origin = (this.env.WEFT_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
    const minted = await this.engine!.mintMcpKey({
      slot: stamp.slot, gen: stamp.gen, principalId: request.headers.get("x-weft-principal"), publicUrl: `${origin}/mcp`,
      expiresAt: new Date(Date.now() + HOSTED_SETTINGS.leaseTotalMinutes * 60_000).toISOString(),
    });
    this.ctx.storage.transactionSync(() => addLeaseKey(this.ctx.storage.sql, minted.key));
    this.engine!.addSecret(minted.key);
    return json(minted, { status: 201 });
  }

  // Outbox -----------------------------------------------------------------------------------------------------

  /** After the outer commit: send each outbox row to its queue, then delete it (design 3.4). At least once. */
  async flushOutbox(): Promise<number> {
    const engine = this.engine;
    if (!engine || this.flushing || !hasKvState(this.ctx.storage.sql)) return 0;
    this.flushing = true;
    let sent = 0;
    const sql = this.ctx.storage.sql;
    const waitOutOfTx = async () => { for (let i = 0; i < 400 && engine.guard.inTx(); i++) await new Promise((r) => setTimeout(r, 5)); };
    try {
      for (;;) {
        await waitOutOfTx();
        const rows = sql.exec(`SELECT id, kind, body FROM outbox ORDER BY created_at, id LIMIT 25`).toArray() as { id: string; kind: string; body: string }[];
        if (!rows.length) break;
        for (const row of rows) {
          let job: HostedJob;
          try { job = JSON.parse(row.body) as HostedJob; } catch {
            logEvent("outbox.poison", { slot: this.stamp?.slot, outcome: row.kind });
            await waitOutOfTx();
            sql.exec(`DELETE FROM outbox WHERE id = ?`, row.id);
            continue;
          }
          engine.guard.assertNotInTx("Queue.send");
          await (queueFor(job.kind) === QUEUES.render ? this.env.RENDER : this.env.JOBS).send(job, { contentType: "json" });
          await waitOutOfTx();
          sql.exec(`DELETE FROM outbox WHERE id = ?`, row.id);
          sent += 1;
        }
      }
      this.alarms.cancel("outbox");
    } catch (e) {
      logError("outbox.flush", e, { slot: this.stamp?.slot });
      await this.alarms.arm("outbox", Date.now() + 30_000);
    } finally {
      this.flushing = false;
    }
    return sent;
  }

  // Alarm ------------------------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    this.usage.requests += 1;
    const due = this.alarms.begin();
    const engine = this.engine;
    if (!engine) {
      if (this.stamp && !this.ctx.storage.kv.get(RESTORE_KEY)) await this.startEngine();
      return;
    }
    this.counter.reset();
    const t0 = Date.now();
    try {
      this.config = await envConfig(this.env);
      const { usage } = await countFetchesIn(this.counter, () => engine.meter.measure(() => engine.inScope(async () => {
        if (due.has("tick")) await this.scheduler.tick();
        if (due.has("runs") || this.runHost.pending().length) {
          const r = await this.runHost.drain();
          logEvent("alarm.runs", { slot: this.stamp?.slot, gen: this.stamp?.gen, outcome: "ok", started: r.started, remaining: r.remaining, live: r.liveStarted, fetches: this.counter.count });
        }
      })));
      this.usage.rowsRead += usage.rowsRead;
      this.usage.rowsWritten += usage.rowsWritten;
      if (due.has("outbox")) await this.flushOutbox();
    } catch (e) {
      logError("alarm", e, { slot: this.stamp?.slot, gen: this.stamp?.gen, ms: Date.now() - t0 });
      for (const p of due) await this.alarms.arm(p, Date.now() + 2_000);
    } finally {
      this.maybePushUsage();
    }
    await this.alarms.sync();
  }

  /** Runs the alarm's work now, as a retried (at-least-once) alarm invocation would: queued runs, a due tick, the
   * outbox. Alarms are at-least-once, so this must never execute a call twice (exec_calls dedupe, design 4.3). */
  async runAlarmNow(): Promise<void> {
    await this.alarms.arm("runs");
    await this.alarm();
  }

  /**
   * Restarts the object (ctx.abort), as an eviction or a deploy does: the next request runs the constructor, and the
   * boot rule fails runs that were running with PROCESS_RESTART (design 3.3). An operations lever for a stuck world.
   */
  async restartWorld(reason = "restart"): Promise<{ ok: true }> {
    setTimeout(() => { try { this.ctx.abort(reason); } catch { /* aborting throws in this context */ } }, 0);
    return { ok: true };
  }

  /** One scheduler tick, measured (design 4.4 and 8.2: a warm idle tick reads about 274 rows and writes 0). */
  async measureTick(): Promise<{ ran: boolean; rowsRead: number; rowsWritten: number; statements: number }> {
    const engine = this.engine;
    if (!engine) return { ran: false, rowsRead: 0, rowsWritten: 0, statements: 0 };
    const { value, usage } = await engine.meter.measure(() => engine.inScope(() => this.scheduler.forceTick()));
    return { ran: value, rowsRead: usage.rowsRead, rowsWritten: usage.rowsWritten, statements: usage.statements };
  }

  /** Fetches made by the last alarm invocation (tests assert at most MAX_FETCHES_PER_ALARM). */
  async alarmFetches(): Promise<{ count: number; peak: number; max: number }> {
    return { count: this.counter.count, peak: this.counter.peak, max: this.counter.max };
  }

  // Usage ------------------------------------------------------------------------------------------------------

  private maybePushUsage(): void {
    const u = this.usage;
    if (!this.stamp || (u.rowsWritten < PUSH_AT.rowsWritten && u.rowsRead < PUSH_AT.rowsRead && u.requests < PUSH_AT.requests)) return;
    const delta = u;
    this.usage = zeroUsage();
    const slot = this.stamp.slot;
    this.ctx.waitUntil(this.env.LOBBY.get(this.env.LOBBY.idFromName(DO_NAMES.lobby)).reportUsage({ slot, usage: delta }).catch((e: unknown) => {
      logError("usage.push", e, { slot });
      this.usage.rowsRead += delta.rowsRead;
      this.usage.rowsWritten += delta.rowsWritten;
      this.usage.requests += delta.requests;
    }));
  }

  // Lobby RPC --------------------------------------------------------------------------------------------------

  /**
   * The Lobby stamps a generation and the lease's visitor (lease start, or a clean slot's next generation). With
   * `ifClean` the stamp is the clean slot's reset: once in-flight mutations are answered, it stamps only if no domain
   * row was written since the last reset, with no await between that check and the stamp; otherwise it answers
   * `ok: false` and stamps nothing (the Lobby then runs the delta reset).
   */
  async applyStamp(s: WorldStamp, opts: { ifClean?: boolean } = {}): Promise<{ ok: boolean; gen: number }> {
    this.assertName(s.slot);
    if (!hasKvState(this.ctx.storage.sql)) throw new Error(`${s.slot} is not provisioned`);
    if (modeOf(s.slot) !== s.mode) throw new Error(`stamp mode ${s.mode} does not match ${s.slot}`);
    if (!opts.ifClean) return this.stampNow(s);
    return this.quiesce(async () => {
      const mod = this.module ?? (await loadEngine());
      if (!mod.store.isClean(this.storage)) return { ok: false, gen: this.stamp?.gen ?? s.gen - 1 };
      return this.stampNow(s);
    });
  }

  private async stampNow(s: WorldStamp): Promise<{ ok: true; gen: number }> {
    const prev = this.stamp;
    this.ctx.storage.transactionSync(() => writeStamp(this.ctx.storage.sql, s));
    this.stamp = s;
    this.lastActivity = s.visitor ? Date.now() : null;
    if (!prev || prev.gen !== s.gen || !this.engine) {
      if (prev && prev.gen !== s.gen) this.closeSockets({ type: "lease", state: "reset", gen: s.gen }, s.gen);
      await this.stopEngine();
      await this.startEngine();
    }
    return { ok: true, gen: s.gen };
  }

  async endLease(input: { gen: number; reason: string }): Promise<void> {
    if (!this.stamp) return;
    this.closeSockets({ type: "lease", state: "ended", gen: input.gen }, null);
    const s: WorldStamp = { ...this.stamp, visitor: null, ipHash: null };
    if (hasKvState(this.ctx.storage.sql)) this.ctx.storage.transactionSync(() => writeStamp(this.ctx.storage.sql, s));
    this.stamp = s;
    this.lastActivity = null;
  }

  async heartbeat(): Promise<SlotHeartbeat> {
    const usage = this.usage;
    this.usage = zeroUsage();
    let clean = true;
    if (this.stamp && hasKvState(this.ctx.storage.sql)) {
      try {
        clean = (this.module ?? (await loadEngine())).store.isClean(this.storage);
      } catch (e) {
        logError("heartbeat.clean", e, { slot: this.stamp.slot });
        clean = false;
      }
    }
    return { stamped: this.stamp, lastActivityMs: this.lastActivity, clean, usage, snapshot: this.ctx.storage.kv.get<string>(SNAPSHOT_KEY) ?? null };
  }

  /** The default reset after a lease (design 4.6): delete dirty rows, reinsert their seed rows, check the digests. */
  async deltaReset(s: WorldStamp): Promise<ResetOutcome> {
    return this.quiesce(() => this.deltaResetNow(s));
  }

  private async deltaResetNow(s: WorldStamp): Promise<ResetOutcome> {
    const t0 = Date.now();
    await this.stopEngine();
    const mod = this.module ?? (await loadEngine());
    const a = await mod.artifacts();
    const r = mod.store.deltaReset(this.storage, a);
    if (!r.ok) {
      logEvent("reset.delta", { slot: s.slot, gen: s.gen, outcome: "mismatch", rowsWritten: r.rowsWritten });
      await this.startEngine();
      return { ok: false, method: "delta", gen: this.stamp?.gen ?? s.gen - 1, rowsWritten: r.rowsWritten, mismatches: r.mismatches, ms: Date.now() - t0 };
    }
    this.ctx.storage.transactionSync(() => writeStamp(this.ctx.storage.sql, s));
    this.closeSockets({ type: "lease", state: s.visitor ? "reset" : "ended", gen: s.gen }, null);
    this.stamp = s;
    this.lastActivity = s.visitor ? Date.now() : null;
    this.alarms.clear();
    await this.startEngine();
    logEvent("reset.delta", { slot: s.slot, gen: s.gen, outcome: "ok", rowsWritten: r.rowsWritten, ms: Date.now() - t0 });
    return { ok: true, method: "delta", gen: s.gen, rowsWritten: r.rowsWritten, mismatches: [], ms: Date.now() - t0 };
  }

  /**
   * Point-in-time recovery (design 4.6), used only after the first-deploy check and with KV reset.pitr=on: the storage
   * returns to the bookmark taken after the slot's full restore at the next session, so the object aborts itself
   * once this call has answered. The Lobby stamps the new generation afterwards.
   */
  async resetToBookmark(input: { bookmark: string; stamp: WorldStamp }): Promise<ResetOutcome> {
    const t0 = Date.now();
    if (!this.storage.onNextSessionRestoreBookmark) return { ok: false, method: "pitr", gen: this.stamp?.gen ?? 0, rowsWritten: 0, mismatches: ["pitr unavailable"], ms: 0 };
    return this.quiesce(async () => {
      await this.stopEngine();
      await this.storage.onNextSessionRestoreBookmark!(input.bookmark);
      setTimeout(() => this.ctx.abort("reset to bookmark"), 0);
      return { ok: true, method: "pitr", gen: input.stamp.gen, rowsWritten: 0, mismatches: [], ms: Date.now() - t0 };
    });
  }

  // ReseedWorkflow RPC: a full restore in short steps (design 4.6 and 9.2) ----------------------------------------

  async restoreBegin(input: RestoreBeginInput): Promise<{ ok: true }> {
    this.assertName(input.slot);
    if (modeOf(input.slot) !== input.mode) throw new Error(`restore mode ${input.mode} does not match ${input.slot}`);
    return this.quiesce(async () => {
      await this.stopEngine();
      this.closeSockets({ type: "lease", state: "ended", gen: input.gen }, null);
      this.alarms.clear();
      this.stamp = null;
      await this.ctx.storage.deleteAll();
      this.ctx.storage.kv.put<RestoreProgress>(RESTORE_KEY, { slot: input.slot, gen: input.gen, mode: input.mode, next: 0, rowsWritten: 0, triggers: [] });
      return { ok: true as const };
    });
  }

  private progress(): RestoreProgress {
    const p = this.ctx.storage.kv.get<RestoreProgress>(RESTORE_KEY);
    if (!p) throw new Error("no restore in progress (restoreBegin first)");
    return p;
  }

  /** Migrations, and the schema's triggers set aside until restoreArm (they persist with the progress). */
  async restoreMigrate(): Promise<{ applied: number }> {
    const p = this.progress();
    const mod = this.module ?? (this.module = await loadEngine());
    const a = await mod.artifacts();
    // One transaction: the triggers it drops and the record of them commit together. A retried step finds them
    // already dropped and keeps the ones the first run set aside.
    return this.ctx.storage.transactionSync(() => {
      const r = mod.store.beginRestore(this.storage, a);
      this.ctx.storage.kv.put<RestoreProgress>(RESTORE_KEY, { ...p, triggers: r.triggers.length ? r.triggers : p.triggers });
      return { applied: r.applied };
    });
  }

  async restoreChunkCount(): Promise<number> {
    this.progress();
    const mod = this.module ?? (this.module = await loadEngine());
    return mod.store.chunkCount(await mod.artifacts());
  }

  /** Chunks [from, to); a retried step skips the chunks already applied (progress commits with each chunk). */
  async restoreChunks(input: { from: number; to: number }): Promise<{ next: number; rowsWritten: number }> {
    const mod = this.module ?? (this.module = await loadEngine());
    const a = await mod.artifacts();
    for (let i = input.from; i < input.to; i++) {
      const p = this.progress();
      if (i < p.next) continue;
      this.ctx.storage.transactionSync(() => {
        const r = mod.store.restoreChunk(this.storage, a, i);
        this.ctx.storage.kv.put<RestoreProgress>(RESTORE_KEY, { ...p, next: i + 1, rowsWritten: p.rowsWritten + r.rowsWritten });
      });
    }
    const p = this.progress();
    return { next: p.next, rowsWritten: p.rowsWritten };
  }

  /** Triggers back, sequences, dirty tracking armed, and cf1's digest check of every table. */
  async restoreArm(): Promise<{ ok: boolean; mismatches: string[] }> {
    const p = this.progress();
    const mod = this.module ?? (this.module = await loadEngine());
    const r = mod.store.finishRestore(this.storage, await mod.artifacts(), p.triggers);
    if (r.ok) this.ctx.storage.kv.put<RestoreProgress>(RESTORE_KEY, { ...p, rowsWritten: p.rowsWritten + r.rowsWritten });
    return { ok: r.ok, mismatches: r.mismatches.slice(0, 20) };
  }

  async restoreVerify(): Promise<RestoreVerify> {
    this.progress();
    const mod = this.module ?? (this.module = await loadEngine());
    const v = mod.store.verify(this.storage, await mod.artifacts(), { full: true });
    return { ok: v.ok, mismatches: v.mismatches.slice(0, 20), chainValid: v.chainValid, rows: v.rows };
  }

  async restoreBookmark(): Promise<string | null> {
    this.progress();
    try { return (await this.storage.getCurrentBookmark?.()) ?? null; } catch { return null; }
  }

  /**
   * Stamps the world and boots it. Idempotent across Workflow retries: the stamp and the end of the restore commit
   * together and are remembered, so a retry after a failed boot only boots again.
   */
  async restoreFinish(input: { bookmark: string | null }): Promise<RestoreFinish> {
    const mod = this.module ?? (this.module = await loadEngine());
    const a = await mod.artifacts();
    const p = this.ctx.storage.kv.get<RestoreProgress>(RESTORE_KEY);
    if (p) {
      const s: WorldStamp = { slot: p.slot, gen: p.gen, mode: p.mode, visitor: null, ipHash: null };
      this.ctx.storage.transactionSync(() => {
        writeStamp(this.ctx.storage.sql, s);
        this.ctx.storage.kv.put(SNAPSHOT_KEY, a.version);
        this.ctx.storage.kv.put<RestoreDone>(RESTORE_DONE_KEY, { slot: p.slot, gen: p.gen, rowsWritten: p.rowsWritten });
        this.ctx.storage.kv.delete(RESTORE_KEY);
      });
      this.stamp = s;
    }
    const done = this.ctx.storage.kv.get<RestoreDone>(RESTORE_DONE_KEY);
    if (!done) throw new Error("no restore in progress (restoreBegin first)");
    if (!this.engine) await this.startEngine();
    if (!this.engine) throw new Error(`restored ${done.slot} but the world did not boot: ${this.bootError ?? "unknown"}`);
    return { slot: done.slot, gen: done.gen, snapshot: a.version, bookmark: input.bookmark, rowsWritten: done.rowsWritten };
  }

  /** The weekly full verify of a clean, unleased world against the manifest (design 4.6); a dirty world is skipped. */
  async verifyWorld(): Promise<{ ok: boolean; skipped: boolean; mismatches: string[]; rows: number }> {
    if (!this.stamp || this.ctx.storage.kv.get(RESTORE_KEY)) return { ok: true, skipped: true, mismatches: [], rows: 0 };
    const mod = this.module ?? (this.module = await loadEngine());
    if (!mod.store.isClean(this.storage) || this.stamp.visitor) return { ok: true, skipped: true, mismatches: [], rows: 0 };
    const v = mod.store.verify(this.storage, await mod.artifacts(), { full: true });
    return { ok: v.ok && v.chainValid, skipped: false, mismatches: v.mismatches.slice(0, 20), rows: v.rows };
  }

  /** A fresh point-in-time bookmark of a clean world (bookmarks cover 30 days); null when unavailable or dirty. */
  async takeBookmark(): Promise<string | null> {
    if (!this.stamp || this.stamp.visitor || !this.storage.getCurrentBookmark) return null;
    const mod = this.module ?? (this.module = await loadEngine());
    if (!mod.store.isClean(this.storage)) return null;
    try { return await this.storage.getCurrentBookmark(); } catch { return null; }
  }

  /** The deployed transaction conformance run on the scratch `conformance` object; it wipes itself afterwards. */
  async runConformance(): Promise<{ passed: number; failed: number; cases: { name: string; ok: boolean; detail?: string }[] }> {
    this.assertName(DO_NAMES.conformance);
    if (this.stamp && this.stamp.mode !== "conformance") throw new Error("conformance runs only on the conformance object");
    const mod = this.module ?? (this.module = await loadEngine());
    if (!mod.store.conformance) throw new Error("this build has no conformance cases");
    try {
      return await mod.store.conformance(this.storage);
    } finally {
      await this.ctx.storage.deleteAll();
    }
  }
}
