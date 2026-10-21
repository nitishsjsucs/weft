// LobbyDO "lobby" (design 3.1, 4.6, 6.2, 6.5 and 9.2, with the section 0 settings): the pool of worlds, leases and
// their generations, the per-IP-hash lease cap, the daily counters against Weft's shares, the waitlist, the
// degradation level and the restore budget. One object, so lease assignment is serialized: a slot is reserved in
// SQL before any await, and 20 concurrent starts get unique slots. Never evaluates @weft/*.
import { DurableObject } from "cloudflare:workers";
import {
  DO_NAMES, HOSTED_CONFIG_KEYS, HOSTED_SETTINGS, slotName,
  type DegradationLevel, type HostedErrorCode, type HostedResetResult, type LeaseInfo, type LeaseResult, type WorldMode,
} from "../../shared/contracts";
import { agentEnabled, CF4_CONFIG_KEYS, configNumber, envConfig } from "../../shared/config";
import { poolSize, type CoreEnv } from "../../shared/env";
import { nextUtcMidnight, utcDay } from "../../shared/http";
import { logError, logEvent } from "../../shared/log";
import type { ResetOutcome, RestoreFinish, UsageDelta, WorldStamp } from "../company/rpc";
import {
  defaultBudget, degradationLevel, emptyUsage, etaMinutes, FULL_RESTORE_ROWS, leaseEnded, leaseExpiresAt, leaseIdleExpiresAt,
  PROVISION_ROWS_CEILING, restoreFits, restoresLeft, sessionFits, SHARES, shareUse, WAITLIST_TTL_MS,
  type BudgetConfig, type DayUsage, type LevelResult,
} from "./policy";

export const LOBBY_SCHEMA_VERSION = "1";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lobby_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS slots (
     name TEXT PRIMARY KEY, mode TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
     snapshot TEXT, bookmark TEXT, workflow TEXT, restored_at INTEGER, error TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leases (
     slot TEXT PRIMARY KEY, visitor TEXT NOT NULL UNIQUE, ip_hash TEXT NOT NULL, gen INTEGER NOT NULL,
     started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, resets INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS counters (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))`,
  `CREATE TABLE IF NOT EXISTS waitlist (visitor TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, at INTEGER NOT NULL, seen INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS vectors (slot TEXT NOT NULL, gen INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY (slot, gen, id))`,
];

/** Slot states. A leased slot is a ready slot with a row in `leases`. */
export type SlotState = "new" | "restoring" | "ready" | "resetting" | "failed";
interface SlotRow { name: string; mode: WorldMode; gen: number; state: SlotState; snapshot: string | null; bookmark: string | null; workflow: string | null; restored_at: number | null; error: string | null }
interface LeaseRow { slot: string; visitor: string; ip_hash: string; gen: number; started_at: number; last_seen: number; resets: number }

export interface LobbyStatus {
  level: DegradationLevel;
  pool: { size: number; free: number; waitlist: number };
  lease: LeaseInfo | null;
  /** The visitor's place on the waitlist, if any. */
  waitlistPosition: number | null;
}

export interface ProvisionStep { slot: string; action: "restore" | "deferred" | "ready" | "leased" | "restoring" | "error"; detail?: string }

export interface LobbyReadout {
  day: string;
  level: DegradationLevel;
  levelReasons: string[];
  restoresLeft: number;
  leases: { active: number; pool: number; waitlist: number };
  lastSweepAt: string | null;
  shares: Record<string, { used: number; share: number }>;
}

type ResetError = { error: HostedErrorCode; message: string };
const COUNTER = {
  visitorRows: "rows_written", restoreRows: "restore_rows", restores: "restores", rowsRead: "rows_read",
  doRequests: "do_requests", workersRequests: "workers_requests",
} as const;

export class LobbyDO extends DurableObject<CoreEnv> {
  private readonly sql: SqlStorage;
  private levelMemo: { at: number; result: LevelResult } | null = null;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      for (const q of SCHEMA) this.sql.exec(q);
      const v = this.one<{ v: string }>(`SELECT v FROM lobby_meta WHERE k = 'schema'`)?.v;
      if (v === undefined) this.sql.exec(`INSERT INTO lobby_meta (k, v) VALUES ('schema', ?)`, LOBBY_SCHEMA_VERSION);
      this.ensureSlots(Date.now());
    });
  }

  // SQL helpers ------------------------------------------------------------------------------------------------

  private all<T>(q: string, ...b: SqlStorageValue[]): T[] {
    return this.sql.exec(q, ...b).toArray() as unknown as T[];
  }
  private one<T>(q: string, ...b: SqlStorageValue[]): T | undefined {
    return this.all<T>(q, ...b)[0];
  }
  private meta(k: string): string | null {
    return this.one<{ v: string }>(`SELECT v FROM lobby_meta WHERE k = ?`, k)?.v ?? null;
  }
  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO lobby_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
  }
  private count(key: string, day = utcDay()): number {
    return this.one<{ n: number }>(`SELECT n FROM counters WHERE day = ? AND key = ?`, day, key)?.n ?? 0;
  }
  private bump(key: string, n: number, day = utcDay()): number {
    if (!n) return this.count(key, day);
    return this.one<{ n: number }>(`INSERT INTO counters (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n RETURNING n`, day, key, Math.round(n))!.n;
  }

  private company(slot: string) {
    return this.env.COMPANY.get(this.env.COMPANY.idFromName(slot));
  }

  /** The worlds the pool has: the showcase, slot-smoke and slot-1 to slot-<WEFT_POOL_SIZE>. New ones start as "new". */
  private ensureSlots(now: number): void {
    const want: { name: string; mode: WorldMode }[] = [
      { name: DO_NAMES.showcase, mode: "showcase" },
      { name: DO_NAMES.smoke, mode: "smoke" },
      ...Array.from({ length: poolSize(this.env) }, (_, i) => ({ name: slotName(i + 1), mode: "slot" as const })),
    ];
    for (const s of want) this.sql.exec(`INSERT INTO slots (name, mode, gen, state, updated_at) VALUES (?, ?, 0, 'new', ?) ON CONFLICT (name) DO NOTHING`, s.name, s.mode, now);
  }

  private slot(name: string): SlotRow | undefined {
    return this.one<SlotRow>(`SELECT name, mode, gen, state, snapshot, bookmark, workflow, restored_at, error FROM slots WHERE name = ?`, name);
  }
  private poolSlots(): SlotRow[] {
    const n = poolSize(this.env);
    return this.all<SlotRow>(`SELECT name, mode, gen, state, snapshot, bookmark, workflow, restored_at, error FROM slots WHERE mode = 'slot' ORDER BY name`)
      .filter((s) => Number(s.name.slice(5)) <= n);
  }
  private leases(): LeaseRow[] {
    return this.all<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases ORDER BY started_at`);
  }
  private freeSlot(): SlotRow | undefined {
    return this.poolSlots().find((s) => s.state === "ready" && !this.one(`SELECT 1 FROM leases WHERE slot = ?`, s.name));
  }

  private usage(day = utcDay()): DayUsage {
    const u = emptyUsage();
    for (const r of this.all<{ key: string; n: number }>(`SELECT key, n FROM counters WHERE day = ?`, day)) {
      if (r.key === COUNTER.visitorRows) u.visitorRowsWritten = r.n;
      else if (r.key === COUNTER.restoreRows) u.restoreRows = r.n;
      else if (r.key === COUNTER.restores) u.restores = r.n;
      else if (r.key === COUNTER.rowsRead) u.doRowsRead = r.n;
      else if (r.key === COUNTER.doRequests) u.doRequests = r.n;
      else if (r.key === COUNTER.workersRequests) u.workersRequests = r.n;
    }
    return u;
  }

  private async config(): Promise<Map<string, string | null>> {
    return envConfig(this.env);
  }
  private budget(cfg: Map<string, string | null>): BudgetConfig {
    const d = defaultBudget();
    return {
      rowsWrittenShare: configNumber(cfg, CF4_CONFIG_KEYS.rowsWrittenShare, d.rowsWrittenShare),
      provisionRowsCeiling: configNumber(cfg, CF4_CONFIG_KEYS.provisionRowsCeiling, PROVISION_ROWS_CEILING),
      fullRestoreRows: configNumber(cfg, CF4_CONFIG_KEYS.fullRestoreRows, FULL_RESTORE_ROWS),
    };
  }

  /** The degradation level, memoized for 30 s (it asks SpendDO and KV). */
  private async levelNow(now = Date.now()): Promise<LevelResult> {
    if (this.levelMemo && now - this.levelMemo.at < 30_000) return this.levelMemo.result;
    const cfg = await this.config();
    let spent = false;
    try {
      const st = await this.env.SPEND.get(this.env.SPEND.idFromName(DO_NAMES.spend)).status({});
      spent = st.spentMicros.day >= st.caps.dayUsd * 1e6 || st.neurons.used >= st.caps.neuronsDay;
    } catch (e) {
      logError("lobby.level.spend", e);
    }
    const floor = Math.min(4, Math.max(0, Math.floor(configNumber(cfg, CF4_CONFIG_KEYS.levelFloor, 0)))) as DegradationLevel;
    const result = degradationLevel({ usage: this.usage(), budget: this.budget(cfg), dollarsOrNeuronsSpent: spent, agentPaused: !agentEnabled(cfg), floor });
    this.levelMemo = { at: now, result };
    return result;
  }

  private leaseInfo(l: LeaseRow): LeaseInfo {
    const t = { startedAt: l.started_at, lastSeen: l.last_seen };
    return {
      slot: l.slot, gen: l.gen, expiresAt: new Date(leaseExpiresAt(t)).toISOString(), idleExpiresAt: new Date(leaseIdleExpiresAt(t)).toISOString(),
      resetsLeft: Math.max(0, HOSTED_SETTINGS.resetsPerLease - l.resets),
    };
  }

  /** Place in arrival order (the row id), counting only entries refreshed within the waitlist TTL. */
  private waitlistPosition(visitor: string, now = Date.now()): number | null {
    const me = this.one<{ r: number }>(`SELECT rowid AS r FROM waitlist WHERE visitor = ?`, visitor);
    if (!me) return null;
    return this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM waitlist WHERE rowid <= ? AND seen > ?`, me.r, now - WAITLIST_TTL_MS)?.n ?? 1;
  }

  // Leases -----------------------------------------------------------------------------------------------------

  /** Design 6.2 step 2: a lease for a visitor who passed Turnstile, or a waitlist place, or why not. */
  async assign(input: { visitor: string; ipHash: string; now?: number }): Promise<LeaseResult> {
    const now = input.now ?? Date.now();
    const day = utcDay(now);
    const existing = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE visitor = ?`, input.visitor);
    if (existing) {
      const ended = leaseEnded({ startedAt: existing.started_at, lastSeen: existing.last_seen }, now);
      if (!ended) return { status: "leased", ...this.leaseInfo(existing) };
      await this.release({ slot: existing.slot, reason: ended, now });
    }
    const { level } = await this.levelNow(now);
    if (level >= 3) return { status: "closed", level };
    if (this.count(`ip:${input.ipHash}`, day) >= HOSTED_SETTINGS.leasesPerIpHashPerDay) return { status: "ip_limit", reopensAt: nextUtcMidnight(now) };
    const cfg = await this.config();
    if (!sessionFits(this.usage(day), this.budget(cfg))) return { status: "budget", reopensAt: nextUtcMidnight(now) };

    let free = this.freeSlot();
    if (!free) {
      await this.reclaim(now);
      free = this.freeSlot();
    }
    if (!free) return this.waitlist(input.visitor, input.ipHash, now);

    // Reserve the slot before any await: a concurrent assign then sees it taken. A concurrent assign for the same
    // visitor that got here first wins, and this one returns its lease.
    const raced = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE visitor = ?`, input.visitor);
    if (raced) return { status: "leased", ...this.leaseInfo(raced) };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO leases (slot, visitor, ip_hash, gen, started_at, last_seen, resets) VALUES (?, ?, ?, ?, ?, ?, 0)`, free!.name, input.visitor, input.ipHash, free!.gen, now, now);
      this.sql.exec(`DELETE FROM waitlist WHERE visitor = ?`, input.visitor);
      this.bump(`ip:${input.ipHash}`, 1, day);
    });
    try {
      await this.company(free.name).applyStamp({ slot: free.name, gen: free.gen, mode: "slot", visitor: input.visitor, ipHash: input.ipHash });
    } catch (e) {
      logError("lobby.assign.stamp", e, { slot: free.name });
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM leases WHERE slot = ? AND visitor = ?`, free!.name, input.visitor);
        this.bump(`ip:${input.ipHash}`, -1, day);
        this.sql.exec(`UPDATE slots SET state = 'failed', error = ?, updated_at = ? WHERE name = ?`, "stamp failed", now, free!.name);
      });
      return this.waitlist(input.visitor, input.ipHash, now);
    }
    logEvent("lease.started", { slot: free.name, gen: free.gen });
    const lease = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE slot = ?`, free.name)!;
    return { status: "leased", ...this.leaseInfo(lease) };
  }

  private waitlist(visitor: string, ipHash: string, now: number): LeaseResult {
    this.sql.exec(`INSERT INTO waitlist (visitor, ip_hash, at, seen) VALUES (?, ?, ?, ?) ON CONFLICT (visitor) DO UPDATE SET seen = excluded.seen`, visitor, ipHash, now, now);
    const leases = this.leases().map((l) => ({ startedAt: l.started_at, lastSeen: l.last_seen }));
    return { status: "waitlist", position: this.waitlistPosition(visitor, now) ?? 1, poolSize: this.poolSlots().length, etaMinutes: etaMinutes(leases, now) };
  }

  /** Ends leases past their total time, and leases whose slot reports no activity for the idle time. */
  private async reclaim(now: number): Promise<number> {
    let n = 0;
    for (const l of this.leases()) {
      let ended = leaseEnded({ startedAt: l.started_at, lastSeen: l.last_seen }, now);
      if (ended === "idle") {
        try {
          const hb = await this.company(l.slot).heartbeat();
          this.absorbUsage(hb.usage);
          if (hb.lastActivityMs !== null && hb.lastActivityMs > l.last_seen) {
            this.sql.exec(`UPDATE leases SET last_seen = ? WHERE slot = ?`, hb.lastActivityMs, l.slot);
            ended = leaseEnded({ startedAt: l.started_at, lastSeen: hb.lastActivityMs }, now);
          }
        } catch (e) {
          logError("lobby.reclaim.heartbeat", e, { slot: l.slot });
        }
      }
      if (ended) {
        await this.release({ slot: l.slot, reason: ended, now });
        n += 1;
      }
    }
    return n;
  }

  /** Session status for the front's GET /api/_session. */
  async status(input: { visitor: string | null; slot?: string | null; gen?: number | null; now?: number }): Promise<LobbyStatus> {
    const now = input.now ?? Date.now();
    const { level } = await this.levelNow(now);
    const pool = this.poolSlots();
    const leased = this.leases();
    const free = pool.filter((s) => s.state === "ready" && !leased.some((l) => l.slot === s.name)).length;
    const waitlistN = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM waitlist WHERE seen > ?`, now - WAITLIST_TTL_MS)?.n ?? 0;
    let lease: LeaseInfo | null = null;
    if (input.visitor) {
      const l = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE visitor = ?`, input.visitor);
      if (l && (input.slot == null || l.slot === input.slot) && (input.gen == null || l.gen === input.gen)) {
        try {
          const hb = await this.company(l.slot).heartbeat();
          this.absorbUsage(hb.usage);
          if (hb.lastActivityMs !== null && hb.lastActivityMs > l.last_seen) {
            this.sql.exec(`UPDATE leases SET last_seen = ? WHERE slot = ?`, hb.lastActivityMs, l.slot);
            l.last_seen = hb.lastActivityMs;
          }
        } catch (e) {
          logError("lobby.status.heartbeat", e, { slot: l.slot });
        }
        const ended = leaseEnded({ startedAt: l.started_at, lastSeen: l.last_seen }, now);
        if (ended) await this.release({ slot: l.slot, reason: ended, now });
        else lease = this.leaseInfo(l);
      }
    }
    return { level, pool: { size: pool.length, free, waitlist: waitlistN }, lease, waitlistPosition: input.visitor ? this.waitlistPosition(input.visitor, now) : null };
  }

  /** Ends a lease and resets its slot right away, so the next visitor gets a clean world (design 6.2 step 4). */
  async release(input: { slot: string; reason: string; now?: number }): Promise<void> {
    const now = input.now ?? Date.now();
    const l = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE slot = ?`, input.slot);
    if (!l) return;
    this.sql.exec(`DELETE FROM leases WHERE slot = ?`, input.slot);
    logEvent("lease.ended", { slot: l.slot, gen: l.gen, outcome: input.reason, ms: now - l.started_at });
    try {
      await this.company(l.slot).endLease({ gen: l.gen, reason: input.reason });
    } catch (e) {
      logError("lobby.release.end", e, { slot: l.slot });
    }
    await this.resetSlot(l.slot, null, now);
  }

  /** "Reset demo data..." for the leased visitor: at most HOSTED_SETTINGS.resetsPerLease per lease. */
  async reset(input: { visitor: string; slot: string; gen: number; now?: number }): Promise<HostedResetResult | ResetError> {
    const now = input.now ?? Date.now();
    const l = this.one<LeaseRow>(`SELECT slot, visitor, ip_hash, gen, started_at, last_seen, resets FROM leases WHERE slot = ? AND visitor = ?`, input.slot, input.visitor);
    if (!l || l.gen !== input.gen || leaseEnded({ startedAt: l.started_at, lastSeen: l.last_seen }, now)) return { error: "LEASE_ENDED", message: "This demo company's lease has ended; start a new one" };
    if (l.resets >= HOSTED_SETTINGS.resetsPerLease) return { error: "RESET_LIMIT", message: `A lease allows ${HOSTED_SETTINGS.resetsPerLease} resets` };
    this.sql.exec(`UPDATE leases SET resets = resets + 1, last_seen = ? WHERE slot = ?`, now, l.slot);
    const out = await this.resetSlot(l.slot, { visitor: l.visitor, ipHash: l.ip_hash }, now);
    if (!out || !out.ok) {
      this.sql.exec(`DELETE FROM leases WHERE slot = ?`, l.slot);
      return { error: "LEASE_ENDED", message: "This demo company is being rebuilt; start a new one in a few minutes" };
    }
    this.sql.exec(`UPDATE leases SET gen = ? WHERE slot = ?`, out.gen, l.slot);
    logEvent("lease.reset", { slot: l.slot, gen: out.gen, outcome: out.method, rowsWritten: out.rowsWritten, ms: out.ms });
    return { ok: true, gen: out.gen, resetsLeft: Math.max(0, HOSTED_SETTINGS.resetsPerLease - l.resets - 1) };
  }

  /** The smoke's and the admin's reset of a world nobody leases (slot-smoke, the showcase): the same reset path. */
  async resetWorld(input: { slot: string; now?: number }): Promise<HostedResetResult | ResetError> {
    const now = input.now ?? Date.now();
    const s = this.slot(input.slot);
    if (!s) return { error: "LEASE_REQUIRED", message: `No world named ${input.slot}` };
    if (this.one(`SELECT 1 FROM leases WHERE slot = ?`, input.slot)) return { error: "LEASE_REQUIRED", message: `${input.slot} is leased; it resets when its lease ends` };
    const out = await this.resetSlot(input.slot, null, now);
    if (!out || !out.ok) return { error: "LEASE_ENDED", message: `${input.slot} is being rebuilt` };
    return { ok: true, gen: out.gen, resetsLeft: HOSTED_SETTINGS.resetsPerLease };
  }

  /**
   * Resets a slot to the seed and stamps the next generation (design 4.6). A clean slot (no domain writes since its
   * last reset) only gets the new generation; a stale slot (another snapshot) gets a full restore; otherwise
   * point-in-time recovery when KV reset.pitr=on and a bookmark exists, else the delta reset. A failed delta reset
   * (digest mismatch) falls back to a full restore.
   */
  private async resetSlot(name: string, keep: { visitor: string; ipHash: string } | null, now: number): Promise<ResetOutcome | null> {
    const s = this.slot(name);
    if (!s || s.state !== "ready") return null;
    const cfg = await this.config();
    const snapshot = cfg.get(HOSTED_CONFIG_KEYS.snapshotVersion) ?? null;
    if (snapshot && s.snapshot && s.snapshot !== snapshot) {
      await this.startRestore(name, now, "stale");
      return null;
    }
    this.sql.exec(`UPDATE slots SET state = 'resetting', updated_at = ? WHERE name = ?`, now, name);
    const stamp: WorldStamp = { slot: name, gen: s.gen + 1, mode: s.mode, visitor: keep?.visitor ?? null, ipHash: keep?.ipHash ?? null };
    let out: ResetOutcome;
    try {
      const co = this.company(name);
      const hb = await co.heartbeat();
      this.absorbUsage(hb.usage);
      if (hb.clean) out = await co.applyStamp(stamp).then((r: { ok: boolean }) => ({ ok: r.ok, method: "stamp" as const, gen: stamp.gen, rowsWritten: 0, mismatches: [], ms: 0 }));
      else if ((cfg.get(CF4_CONFIG_KEYS.resetPitr) ?? "off") === "on" && s.bookmark) {
        out = await co.resetToBookmark({ bookmark: s.bookmark, stamp });
        // The object restarts on the bookmark (its stamp is the restore's); stamp the new generation once it is back.
        if (out.ok) out = { ...out, ok: await this.stampWithRetry(name, stamp) };
      } else out = await co.deltaReset(stamp);
    } catch (e) {
      logError("lobby.reset", e, { slot: name });
      out = { ok: false, method: "delta", gen: s.gen, rowsWritten: 0, mismatches: ["error"], ms: 0 };
    }
    this.bump(COUNTER.visitorRows, out.rowsWritten);
    if (!out.ok) {
      logEvent("reset.mismatch", { slot: name, gen: s.gen, outcome: out.mismatches.slice(0, 5).join(",") });
      this.sql.exec(`UPDATE slots SET state = 'ready', updated_at = ? WHERE name = ?`, now, name);
      await this.startRestore(name, now, "mismatch");
      return out;
    }
    this.sql.exec(`UPDATE slots SET state = 'ready', gen = ?, updated_at = ? WHERE name = ?`, out.gen, now, name);
    await this.dropVectors(name, s.gen);
    return out;
  }

  private async stampWithRetry(name: string, stamp: WorldStamp): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      try {
        await this.company(name).applyStamp(stamp);
        return true;
      } catch (e) {
        if (i === 3) logError("lobby.stamp.retry", e, { slot: name });
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
    return false;
  }

  // Full restores and provisioning -----------------------------------------------------------------------------

  /** Starts ReseedWorkflow for a slot if today's restore budget allows (design 9.2); otherwise leaves it for a later sweep. */
  private async startRestore(name: string, now: number, why: string): Promise<ProvisionStep> {
    const s = this.slot(name);
    if (!s) return { slot: name, action: "error", detail: "unknown slot" };
    if (s.state === "restoring") return { slot: name, action: "restoring" };
    if (this.one(`SELECT 1 FROM leases WHERE slot = ?`, name)) return { slot: name, action: "leased" };
    const cfg = await this.config();
    const b = this.budget(cfg);
    if (!restoreFits(this.usage(), b)) {
      this.sql.exec(`UPDATE slots SET state = CASE WHEN state = 'ready' THEN 'failed' ELSE state END, error = ?, updated_at = ? WHERE name = ?`, `restore deferred (${why})`, now, name);
      this.setMeta("provision.pending", "1");
      return { slot: name, action: "deferred", detail: "restore budget used for today" };
    }
    const gen = s.gen + 1;
    const id = `reseed-${name}-g${gen}-${now.toString(36)}`;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE slots SET state = 'restoring', workflow = ?, error = NULL, updated_at = ? WHERE name = ?`, id, now, name);
      this.bump(COUNTER.restoreRows, b.fullRestoreRows);
      this.bump(COUNTER.restores, 1);
    });
    this.levelMemo = null;
    try {
      await this.env.RESEED.create({ id, params: { slot: name, gen, mode: s.mode, reason: why } });
    } catch (e) {
      logError("lobby.restore.start", e, { slot: name });
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`UPDATE slots SET state = 'failed', error = 'workflow create failed', updated_at = ? WHERE name = ?`, now, name);
        this.bump(COUNTER.restoreRows, -b.fullRestoreRows);
        this.bump(COUNTER.restores, -1);
      });
      return { slot: name, action: "error", detail: "workflow create failed" };
    }
    logEvent("reset.full.started", { slot: name, gen, outcome: why });
    return { slot: name, action: "restore" };
  }

  /** Called by ReseedWorkflow's last step. */
  async restoreDone(input: RestoreFinish & { ok: boolean; error?: string; now?: number }): Promise<void> {
    const now = input.now ?? Date.now();
    const b = this.budget(await this.config());
    this.ctx.storage.transactionSync(() => {
      if (input.ok) {
        this.sql.exec(`UPDATE slots SET state = 'ready', gen = ?, snapshot = ?, bookmark = ?, restored_at = ?, workflow = NULL, error = NULL, updated_at = ? WHERE name = ?`,
          input.gen, input.snapshot, input.bookmark, now, now, input.slot);
        if (input.rowsWritten > 0) this.bump(COUNTER.restoreRows, input.rowsWritten - b.fullRestoreRows);
      } else {
        this.sql.exec(`UPDATE slots SET state = 'failed', workflow = NULL, error = ?, updated_at = ? WHERE name = ?`, (input.error ?? "restore failed").slice(0, 200), now, input.slot);
      }
    });
    this.levelMemo = null;
    logEvent(input.ok ? "reset.full" : "reset.full.failed", { slot: input.slot, gen: input.gen, rowsWritten: input.rowsWritten });
  }

  /**
   * POST /api/_admin/provision (design 9.2): registers the worlds and starts a full restore for every world that has
   * none yet (or all with `force`), in order showcase, slot-smoke, slot-1..N, as today's restore budget allows. The
   * rest wait for the cron sweep on the next UTC day.
   */
  async provision(input: { slots?: string[]; force?: boolean; now?: number } = {}): Promise<ProvisionStep[]> {
    const now = input.now ?? Date.now();
    this.ensureSlots(now);
    this.setMeta("provision.requested", "1");
    const cfg = await this.config();
    const snapshot = cfg.get(HOSTED_CONFIG_KEYS.snapshotVersion) ?? null;
    const order = [DO_NAMES.showcase, DO_NAMES.smoke, ...this.poolSlots().map((s) => s.name)];
    const targets = input.slots?.length ? order.filter((n) => input.slots!.includes(n)) : order;
    const out: ProvisionStep[] = [];
    for (const name of targets) {
      const s = this.slot(name)!;
      const needs = input.force || s.state === "new" || s.state === "failed" || (snapshot !== null && s.snapshot !== null && s.snapshot !== snapshot);
      if (!needs) { out.push({ slot: name, action: s.state === "restoring" ? "restoring" : "ready" }); continue; }
      out.push(await this.startRestore(name, now, input.force ? "force" : s.state === "new" ? "first" : "stale"));
    }
    this.setMeta("provision.pending", out.some((s) => s.action === "deferred" || s.action === "leased") ? "1" : "0");
    return out;
  }

  // Counters ---------------------------------------------------------------------------------------------------

  private absorbUsage(u: UsageDelta | undefined): void {
    if (!u) return;
    this.bump(COUNTER.visitorRows, u.rowsWritten);
    this.bump(COUNTER.rowsRead, u.rowsRead);
    this.bump(COUNTER.doRequests, u.requests);
  }

  /** Slots push their facade meter totals when they pass a threshold, and at lease end. */
  async reportUsage(input: { slot: string; usage: UsageDelta; workersRequests?: number }): Promise<void> {
    this.absorbUsage(input.usage);
    if (input.workersRequests) this.bump(COUNTER.workersRequests, input.workersRequests);
  }

  /** A daily counter with a limit (help queries, uploads per visitor, MCP agent_ask per key, browser seconds). */
  async take(input: { key: string; limit: number; n?: number; now?: number }): Promise<{ ok: boolean; used: number; left: number }> {
    const day = utcDay(input.now ?? Date.now());
    const n = input.n ?? 1;
    const used = this.count(input.key, day);
    if (used + n > input.limit) return { ok: false, used, left: Math.max(0, input.limit - used) };
    const after = this.bump(input.key, n, day);
    return { ok: true, used: after, left: Math.max(0, input.limit - after) };
  }

  async counter(input: { key: string; day?: string }): Promise<number> {
    return this.count(input.key, input.day ?? utcDay());
  }

  /** Vector ids a slot upserted in a generation, so a reset can delete them by id (design 4.6). */
  async recordVectors(input: { slot: string; gen: number; ids: string[] }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const id of input.ids) this.sql.exec(`INSERT INTO vectors (slot, gen, id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, input.slot, input.gen, id);
    });
  }

  private async dropVectors(slot: string, gen: number): Promise<void> {
    const ids = this.all<{ id: string }>(`SELECT id FROM vectors WHERE slot = ? AND gen <= ?`, slot, gen).map((r) => r.id);
    if (!ids.length) return;
    try {
      for (let i = 0; i < ids.length; i += 100) await this.env.MEMVEC?.deleteByIds(ids.slice(i, i + 100));
      this.sql.exec(`DELETE FROM vectors WHERE slot = ? AND gen <= ?`, slot, gen);
    } catch (e) {
      logError("lobby.vectors.delete", e, { slot });
    }
  }

  // Cron sweep -------------------------------------------------------------------------------------------------

  /** The cron sweep every 15 minutes (design 3.1): lease expiry, orphan settle, deferred provisioning, waitlist pruning, the daily budget row. */
  async sweep(input: { now?: number } = {}): Promise<{ released: number; orphans: number; restores: ProvisionStep[]; level: DegradationLevel }> {
    const now = input.now ?? Date.now();
    this.ensureSlots(now);
    const released = await this.reclaim(now);
    let orphans = 0;
    try {
      orphans = await this.env.SPEND.get(this.env.SPEND.idFromName(DO_NAMES.spend)).settleOrphans(new Date(now).toISOString());
    } catch (e) {
      logError("lobby.sweep.orphans", e);
    }
    const restores: ProvisionStep[] = [];
    if (this.meta("provision.requested") === "1") {
      for (const s of this.all<SlotRow>(`SELECT name, mode, gen, state, snapshot, bookmark, workflow, restored_at, error FROM slots WHERE state IN ('new', 'failed') ORDER BY CASE mode WHEN 'showcase' THEN 0 WHEN 'smoke' THEN 1 ELSE 2 END, name`)) {
        const step = await this.startRestore(s.name, now, s.state === "new" ? "first" : "retry");
        restores.push(step);
        if (step.action === "deferred") break;
      }
    }
    this.sql.exec(`DELETE FROM waitlist WHERE seen < ?`, now - WAITLIST_TTL_MS);
    this.sql.exec(`DELETE FROM counters WHERE day < ?`, utcDay(now - 8 * 86_400_000));
    this.levelMemo = null;
    const { level } = await this.levelNow(now);
    await this.writeBudgetRow(now, level);
    this.setMeta("sweep.at", new Date(now).toISOString());
    logEvent("lobby.sweep", { outcome: "ok", released, orphans, restores: restores.length, level });
    return { released, orphans, restores, level };
  }

  /** The daily budget rows in D1 weft-ops, one per share (best effort: the table belongs to apps/cf/d1). */
  private async writeBudgetRow(now: number, level: DegradationLevel): Promise<void> {
    if (!this.env.OPS) return;
    const day = utcDay(now);
    const u = this.usage(day);
    const b = this.budget(await this.config());
    const at = new Date(now).toISOString();
    const rows: [string, number, number | null][] = [
      ...Object.entries(shareUse(u, b)).map(([k, v]) => [`lobby.${k}`, v.used, v.share] as [string, number, number]),
      ["lobby.restore_rows", u.restoreRows, null],
      ["lobby.restores", u.restores, null],
      ["lobby.level", level, 4],
    ];
    try {
      await this.env.OPS.batch(rows.map(([metric, used, share]) => this.env.OPS!.prepare(
        `INSERT INTO budget_daily (day, metric, used, share, source, updated_at) VALUES (?1, ?2, ?3, ?4, 'lobby', ?5)
         ON CONFLICT (day, metric) DO UPDATE SET used = excluded.used, share = excluded.share, source = excluded.source, updated_at = excluded.updated_at`,
      ).bind(day, metric, used, share, at)));
    } catch (e) {
      logError("lobby.budget_row", e);
    }
  }

  // Readouts ---------------------------------------------------------------------------------------------------

  async readout(input: { now?: number } = {}): Promise<LobbyReadout> {
    const now = input.now ?? Date.now();
    const cfg = await this.config();
    const b = this.budget(cfg);
    const u = this.usage(utcDay(now));
    const lv = await this.levelNow(now);
    return {
      day: utcDay(now),
      level: lv.level,
      levelReasons: lv.reasons,
      restoresLeft: restoresLeft(u, b),
      leases: {
        active: this.leases().length,
        pool: this.poolSlots().length,
        waitlist: this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM waitlist WHERE seen > ?`, now - WAITLIST_TTL_MS)?.n ?? 0,
      },
      lastSweepAt: this.meta("sweep.at"),
      shares: shareUse(u, b),
    };
  }

  /** The admin-only GET /api/_admin/ops readout (no visitor ids, no IP hashes). */
  async ops(input: { now?: number } = {}): Promise<{ readout: LobbyReadout; slots: Omit<SlotRow, "bookmark">[]; leases: { slot: string; gen: number; startedAt: string; lastSeen: string; resets: number }[]; usage: DayUsage; shares: typeof SHARES }> {
    const readout = await this.readout(input);
    return {
      readout,
      slots: this.all<SlotRow>(`SELECT name, mode, gen, state, snapshot, bookmark, workflow, restored_at, error FROM slots ORDER BY name`).map(({ bookmark: _b, ...s }) => s),
      leases: this.leases().map((l) => ({ slot: l.slot, gen: l.gen, startedAt: new Date(l.started_at).toISOString(), lastSeen: new Date(l.last_seen).toISOString(), resets: l.resets })),
      usage: this.usage(),
      shares: SHARES,
    };
  }

  /** The world a slot name maps to now (the front's smoke and admin paths). */
  async world(input: { slot: string }): Promise<{ slot: string; gen: number; mode: WorldMode; state: SlotState } | null> {
    const s = this.slot(input.slot);
    return s ? { slot: s.name, gen: s.gen, mode: s.mode, state: s.state } : null;
  }

  override async fetch(): Promise<Response> {
    return new Response("LobbyDO answers RPC only", { status: 404 });
  }
}
