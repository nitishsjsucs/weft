// SpendDO's ledger (design 4.1, 4.3, 5.2 and 6.3): `spend_entries` and `neuron_entries` in the SpendDO's own SQLite,
// never reset with a world. It keeps the file ledger's semantics (packages/agent/src/spend.ts): a reservation opens at
// its reserved amount, a settle replaces it, a release zeroes it, open reservations count as spent, settle and release
// rows copy the reservation's scope columns (so they land in its day), and the per-run cap keys a run by its world
// and its id. The hosted caps add the visitor and IP-hash day caps, the neuron day cap with per-product shares, a
// cumulative live cap that is off by default (section 0), and orphans settled at their reserved worst case after
// ORPHAN_SETTLE_MS. Reserve checks and inserts in one synchronous transaction, so two slots racing for the last cents
// of the day cap cannot both pass. Pure over SqlStorageLike: unit tests run it on node:sqlite.
//
// Rows read stay flat (design 8.2: DO rows read are an account-wide daily cap any visitor can spend): each retained
// day's fold and direct neurons (today and the RETAIN_DAYS - 1 days before it) and the live totals are kept in
// memory, each built once per object (a day's rows and the live rows, each through an index) and updated by every
// write after it commits, since every write goes through this ledger in this one object. A status, and a day's or the
// live totals (GET /v1/agent/costs, which any visitor can call), read no row once built; a day outside the retained
// ones answers zero and reads nothing; a reservation reads only its run's rows. The orphan sweep reads only the
// reservations that crossed the orphan age since its last run, and prunes entries older than RETAIN_DAYS a bounded
// batch at a time (live totals of pruned rows carry over in spend_meta, so the cumulative live cap still counts them).
import {
  FROZEN_CAP, NEURON_SHARES, ORPHAN_SETTLE_MS,
  type HostedCap, type HostedCaps, type HostedReserveInput, type HostedReserveRefusal, type HostedSpendScope,
  type HostedSpendStatus, type NeuronProduct, type SqlStorageLike, type SqlStorageValue,
} from "../../shared/contracts";
import { randomHex } from "../../shared/crypto";

export const SPEND_SCHEMA_VERSION = "1";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS spend_entries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, world TEXT, run_id TEXT,
     kind TEXT NOT NULL, reservation_id TEXT NOT NULL, usd_micros INTEGER NOT NULL, model TEXT NOT NULL,
     live INTEGER NOT NULL, visitor TEXT, ip_hash TEXT, neurons INTEGER NOT NULL DEFAULT 0, product TEXT)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_day ON spend_entries(day)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_rsv ON spend_entries(reservation_id)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_run ON spend_entries(world, run_id) WHERE run_id IS NOT NULL`,
  // The live totals' one build per object, and the orphan sweep's window of reservations by age.
  `CREATE INDEX IF NOT EXISTS spend_entries_live ON spend_entries(seq) WHERE live = 1`,
  `CREATE INDEX IF NOT EXISTS spend_entries_reserve_at ON spend_entries(at) WHERE kind = 'reserve'`,
  `CREATE TABLE IF NOT EXISTS neuron_entries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, product TEXT NOT NULL,
     model TEXT NOT NULL, neurons INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS neuron_entries_day ON neuron_entries(day)`,
];

export interface SyncSql {
  readonly sql: SqlStorageLike;
  transactionSync<T>(fn: () => T): T;
}

export function migrateSpend(s: SyncSql): void {
  s.transactionSync(() => {
    for (const q of SCHEMA) s.sql.exec(q);
    const v = s.sql.exec<{ v: string }>(`SELECT v FROM spend_meta WHERE k = 'schema'`).toArray()[0]?.v;
    if (v === undefined) s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES ('schema', ?)`, SPEND_SCHEMA_VERSION);
    else if (v !== SPEND_SCHEMA_VERSION) throw new Error(`SpendDO schema ${v} is newer than this code (${SPEND_SCHEMA_VERSION})`);
  });
}

export interface SpendRow {
  at: string; day: string; world: string | null; run_id: string | null; kind: "reserve" | "settle" | "release";
  reservation_id: string; usd_micros: number; model: string; live: number; visitor: string | null; ip_hash: string | null;
  neurons: number; product: string | null;
}

interface Folded { r: SpendRow; micros: number; neurons: number; open: boolean }

/** One step of the file ledger's fold: a reserve opens at its reserved amount, a settle or release closes it. */
export function foldInto(m: Map<string, Folded>, e: SpendRow): void {
  if (e.kind === "reserve") {
    m.set(e.reservation_id, { r: e, micros: e.usd_micros, neurons: e.neurons, open: true });
    return;
  }
  const cur = m.get(e.reservation_id);
  if (!cur) return;
  cur.micros = e.kind === "settle" ? e.usd_micros : 0;
  cur.neurons = e.kind === "settle" ? e.neurons : 0;
  cur.open = false;
}

/** The file ledger's fold: per reservation, open at its reserved amount until a settle or release closes it. */
export function fold(rows: readonly SpendRow[]): Map<string, Folded> {
  const m = new Map<string, Folded>();
  for (const e of rows) foldInto(m, e);
  return m;
}

export interface Totals { settledMicros: number; openMicros: number; neurons: number }
const committedOf = (t: Totals) => t.settledMicros + t.openMicros;
const zeroTotals = (): Totals => ({ settledMicros: 0, openMicros: 0, neurons: 0 });

function totalsOf(folded: Iterable<Folded>, keep: (r: SpendRow) => boolean = () => true): Totals {
  const t = zeroTotals();
  for (const f of folded) {
    if (!keep(f.r)) continue;
    if (f.open) t.openMicros += f.micros;
    else t.settledMicros += f.micros;
    t.neurons += f.neurons;
  }
  return t;
}

/** Spend entries are kept this many UTC days back (today included); older ones are pruned by the orphan sweep. */
export const RETAIN_DAYS = 3;
const DAY_MS = 86_400_000;
/** The UTC days the ledger keeps at `now`: today first, then the RETAIN_DAYS - 1 days before it. */
export const retainedDays = (now: Date): string[] =>
  Array.from({ length: RETAIN_DAYS }, (_, i) => new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
/** The orphan sweep looks back at most this far the first time (and after a long gap); older reservations stay. */
const ORPHAN_LOOKBACK_MS = 2 * 86_400_000;
const META = { orphansScannedTo: "orphans.scanned_to", liveCarry: "live.carry" } as const;

export interface SqlSpendLedgerOptions {
  /** Current caps (KV, then vars, then the defaults); read at every reservation. */
  caps: () => HostedCaps;
  /** Wall clock, never the sim clock. */
  wallNow?: () => Date;
  neuronShares?: Record<NeuronProduct, number>;
}

export type ReserveResult = { ok: true; reservationId: string } | HostedReserveRefusal;

export interface SqlSpendLedger {
  reserve(input: HostedReserveInput): ReserveResult;
  settle(reservationId: string, actualUsdMicros: number, actual?: { neurons?: number }): void;
  release(reservationId: string): void;
  spent(scope: HostedSpendScope): number;
  committed(scope: HostedSpendScope): Totals;
  status(scope: { visitor?: string | null; ipHash?: string | null }): HostedSpendStatus;
  /** Settles reservations open longer than ORPHAN_SETTLE_MS at their worst case, and prunes entries older than
   * RETAIN_DAYS; returns how many reservations it settled. */
  settleOrphans(now?: Date): number;
  /** Neurons used outside a reservation (OCR, embeddings, dictation): counted against the day cap and the product's share. */
  recordNeurons(input: { product: NeuronProduct; model: string; neurons: number }): void;
  /** Whether `neurons` more for `product` fit today. */
  neuronsLeft(product: NeuronProduct): { product: number; day: number };
  entries(day?: string): SpendRow[];
}

const ROW_COLS = "at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product";
const PRODUCTS: readonly NeuronProduct[] = ["agent", "ocr", "embeddings", "dictation"];
const noNeurons = (): Record<NeuronProduct, number> => ({ agent: 0, ocr: 0, embeddings: 0, dictation: 0 });

/** What the ledger keeps in memory for one retained UTC day: the fold of its entries and its direct neurons. */
interface DayState { day: string; folded: Map<string, Folded>; direct: Record<NeuronProduct, number> }

function addTotals(a: Totals, b: Totals): Totals {
  return { settledMicros: a.settledMicros + b.settledMicros, openMicros: a.openMicros + b.openMicros, neurons: a.neurons + b.neurons };
}

export function createSqlSpendLedger(s: SyncSql, opts: SqlSpendLedgerOptions): SqlSpendLedger {
  const wallNow = opts.wallNow ?? (() => new Date());
  const shares = opts.neuronShares ?? NEURON_SHARES;
  const today = () => wallNow().toISOString().slice(0, 10);
  const q = <T>(query: string, ...b: SqlStorageValue[]): T[] => s.sql.exec(query, ...b).toArray() as unknown as T[];

  const rowsForDay = (day: string) => q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE day = ? ORDER BY seq`, day);
  const rowsForRun = (world: string | null, runId: string) => world === null
    ? q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE world IS NULL AND run_id = ? ORDER BY seq`, runId)
    : q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE world = ? AND run_id = ? ORDER BY seq`, world, runId);
  const rowsLive = () => q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE live = 1 ORDER BY seq`);
  const meta = (k: string): string | null => q<{ v: string }>(`SELECT v FROM spend_meta WHERE k = ?`, k)[0]?.v ?? null;
  const setMeta = (k: string, v: string) => s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);

  // In-memory state ----------------------------------------------------------------------------------------------

  /** The retained days' folds and direct neurons, by day: each read once per object (through the day indexes) on its
   * first use, then kept by apply() and recordNeurons(). A day that leaves the retained ones is dropped. */
  const days = new Map<string, DayState>();
  /** The retained day's state (built on first use), or null for any other day: nothing is kept or read for it. */
  function dayState(day: string, now = wallNow()): DayState | null {
    const keep = retainedDays(now);
    for (const d of days.keys()) if (!keep.includes(d)) days.delete(d);
    if (!keep.includes(day)) return null;
    let st = days.get(day);
    if (!st) {
      const direct = noNeurons();
      for (const d of q<{ product: string; n: number }>(`SELECT product, SUM(neurons) AS n FROM neuron_entries WHERE day = ? GROUP BY product`, day)) {
        if ((PRODUCTS as readonly string[]).includes(d.product)) direct[d.product as NeuronProduct] += Number(d.n);
      }
      st = { day, folded: fold(rowsForDay(day)), direct };
      days.set(day, st);
    }
    return st;
  }
  /** Today's state. */
  function current(): DayState {
    const now = wallNow();
    return dayState(now.toISOString().slice(0, 10), now)!;
  }

  /** Every live reservation ever made (pruned ones carried in spend_meta), folded: built on first use, then kept. */
  let liveTotals: Totals | null = null;
  function live(): Totals {
    if (!liveTotals) {
      const carry = parseCarry(meta(META.liveCarry));
      const t = totalsOf(fold(rowsLive()).values());
      liveTotals = addTotals(carry, t);
    }
    return liveTotals;
  }

  /**
   * Keeps the in-memory state in step with an entry that was just committed (`reservation` is the reserve row a settle
   * or release closes). Called only after the transaction that wrote it returned, so a rolled-back write never counts.
   */
  function apply(e: SpendRow, reservation: SpendRow | null): void {
    // A day not built yet reads this row when it is; a day no longer retained is gone.
    const st = days.get(e.day);
    if (st) foldInto(st.folded, e);
    if (liveTotals && e.live === 1) {
      if (e.kind === "reserve") { liveTotals.openMicros += e.usd_micros; liveTotals.neurons += e.neurons; }
      else if (reservation) {
        liveTotals.openMicros -= reservation.usd_micros;
        liveTotals.neurons -= reservation.neurons;
        if (e.kind === "settle") { liveTotals.settledMicros += e.usd_micros; liveTotals.neurons += e.neurons; }
      }
    }
  }

  function neuronUse(st: DayState): { total: number; byProduct: Record<NeuronProduct, number> } {
    const byProduct = { ...st.direct };
    for (const f of st.folded.values()) {
      if (!f.neurons) continue;
      const p = (f.r.product ?? "agent") as NeuronProduct;
      if (p in byProduct) byProduct[p] += f.neurons;
    }
    return { total: Object.values(byProduct).reduce((a, b) => a + b, 0), byProduct };
  }

  // Queries --------------------------------------------------------------------------------------------------------

  function scopeTotals(scope: HostedSpendScope): Totals {
    const keep = (r: SpendRow) =>
      (scope.day === undefined || r.day === scope.day)
      && (scope.live === undefined || (r.live === 1) === scope.live)
      && (scope.visitor === undefined || r.visitor === scope.visitor)
      && (scope.ipHash === undefined || r.ip_hash === scope.ipHash)
      && (scope.runId === undefined || scope.world === undefined || r.world === scope.world);
    // A run's totals read the run's own rows (through its index). Everything else comes from memory: a retained day's
    // fold, nothing for any other day (no query), the live totals, and otherwise the retained days together (older
    // entries are pruned, so they are the whole table but for what the next sweep prunes).
    if (scope.runId !== undefined) return totalsOf(fold(rowsForRun(scope.world ?? null, scope.runId)).values(), keep);
    const now = wallNow();
    if (scope.day !== undefined) {
      const st = dayState(scope.day, now);
      return st ? totalsOf(st.folded.values(), keep) : zeroTotals();
    }
    if (scope.live === true && scope.visitor === undefined && scope.ipHash === undefined) return { ...live() };
    return retainedDays(now).reduce((t, day) => addTotals(t, totalsOf(dayState(day, now)!.folded.values(), keep)), zeroTotals());
  }

  function insert(e: SpendRow): void {
    s.sql.exec(`INSERT INTO spend_entries (${ROW_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.at, e.day, e.world, e.run_id, e.kind, e.reservation_id, e.usd_micros, e.model, e.live, e.visitor, e.ip_hash, e.neurons, e.product);
  }

  function findReservation(id: string): SpendRow | null {
    return q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE reservation_id = ? AND kind = 'reserve' LIMIT 1`, id)[0] ?? null;
  }
  function isClosed(id: string): boolean {
    return q(`SELECT 1 FROM spend_entries WHERE reservation_id = ? AND kind != 'reserve' LIMIT 1`, id).length > 0;
  }

  function close(id: string, kind: "settle" | "release", usd: number, neurons: number): void {
    const done = s.transactionSync((): [SpendRow, SpendRow] | null => {
      const r = findReservation(id);
      if (!r || isClosed(id)) return null;   // unknown, or already closed: a replayed settle changes nothing
      const e: SpendRow = { ...r, kind, usd_micros: Math.max(0, Math.ceil(usd)), neurons: Math.max(0, Math.ceil(neurons)) };
      insert(e);
      return [e, r];
    });
    if (done) apply(done[0], done[1]);
  }

  return {
    reserve(input) {
      const out = s.transactionSync((): { result: ReserveResult; row: SpendRow | null } => {
        const caps = opts.caps();
        const st = current();
        const usd = Math.max(0, Math.ceil(input.usdMicros));
        const neurons = Math.max(0, Math.ceil(input.neurons ?? 0));
        const product: NeuronProduct = input.product ?? "agent";
        const world = input.world ?? null;
        const dayFolded = st.folded;
        const checks: { cap: HostedCap; capMicros: number; committed: () => number }[] = [];
        if (input.runId !== null) {
          const scale = Math.max(1, input.runCapScale ?? 1);
          checks.push({ cap: "run", capMicros: caps.runUsd * scale * 1e6, committed: () => committedOf(totalsOf(fold(rowsForRun(world, input.runId!)).values())) });
        }
        checks.push({ cap: "day", capMicros: caps.dayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values())) });
        if (input.live && caps.liveUsd !== null) checks.push({ cap: "live", capMicros: caps.liveUsd * 1e6, committed: () => committedOf(live()) });
        if (input.visitor) checks.push({ cap: "visitor", capMicros: caps.visitorDayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values(), (r) => r.visitor === input.visitor)) });
        if (input.ipHash) checks.push({ cap: "ip", capMicros: caps.ipDayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values(), (r) => r.ip_hash === input.ipHash)) });
        for (const c of checks) {
          const committed = c.committed();
          if (committed + usd > c.capMicros) {
            return { row: null, result: { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP[c.cap], hostedCap: c.cap, spentMicros: committed, capMicros: Math.round(c.capMicros) } };
          }
        }
        if (neurons > 0) {
          const use = neuronUse(st);
          const share = shares[product] ?? 0;
          if (use.total + neurons > caps.neuronsDay || use.byProduct[product] + neurons > share) {
            return { row: null, result: { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP.neurons, hostedCap: "neurons", spentMicros: use.total, capMicros: Math.min(caps.neuronsDay, share) } };
          }
        }
        const reservationId = `rsv_${randomHex(8)}`;
        const row: SpendRow = {
          at: wallNow().toISOString(), day: st.day, world, run_id: input.runId, kind: "reserve", reservation_id: reservationId, usd_micros: usd,
          model: input.model, live: input.live ? 1 : 0, visitor: input.visitor ?? null, ip_hash: input.ipHash ?? null,
          neurons, product: neurons > 0 ? product : null,
        };
        insert(row);
        return { row, result: { ok: true, reservationId } };
      });
      if (out.row) apply(out.row, null);
      return out.result;
    },
    settle(id, actual, extra) {
      const r = findReservation(id);
      close(id, "settle", actual, extra?.neurons ?? r?.neurons ?? 0);
    },
    release(id) {
      close(id, "release", 0, 0);
    },
    spent(scope) {
      return scopeTotals(scope).settledMicros;
    },
    committed(scope) {
      return scopeTotals(scope);
    },
    status(scope) {
      const st = current();
      const caps = opts.caps();
      const all = [...st.folded.values()];
      const use = neuronUse(st);
      return {
        day: st.day,
        caps,
        spentMicros: {
          day: committedOf(totalsOf(all)),
          visitor: scope.visitor ? committedOf(totalsOf(all, (r) => r.visitor === scope.visitor)) : null,
          ip: scope.ipHash ? committedOf(totalsOf(all, (r) => r.ip_hash === scope.ipHash)) : null,
          live: committedOf(live()),
        },
        neurons: { used: use.total, byProduct: use.byProduct },
        openReservations: all.filter((f) => f.open).length,
      };
    },
    settleOrphans(now = wallNow()) {
      const cutoff = new Date(now.getTime() - ORPHAN_SETTLE_MS).toISOString();
      const floor = new Date(now.getTime() - ORPHAN_LOOKBACK_MS).toISOString();
      const keepFrom = new Date(now.getTime() - (RETAIN_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
      const done = s.transactionSync(() => {
        // Only reservations that crossed the orphan age since the last sweep: every older one was settled then, or
        // closed itself. The first sweep (and one after a long gap) looks back ORPHAN_LOOKBACK_MS.
        const scannedTo = meta(META.orphansScannedTo);
        const from = scannedTo !== null && scannedTo > floor ? scannedTo : floor;
        const open = from < cutoff ? q<SpendRow>(
          `SELECT ${ROW_COLS} FROM spend_entries r WHERE r.kind = 'reserve' AND r.at >= ? AND r.at < ?
             AND NOT EXISTS (SELECT 1 FROM spend_entries x WHERE x.reservation_id = r.reservation_id AND x.kind != 'reserve')
           ORDER BY r.seq`, from, cutoff) : [];
        const settled: [SpendRow, SpendRow][] = [];
        for (const r of open) {
          const e: SpendRow = { ...r, kind: "settle" };   // worst case: the reserved amount and neurons
          insert(e);
          settled.push([e, r]);
        }
        if (scannedTo === null || cutoff > scannedTo) setMeta(META.orphansScannedTo, cutoff);
        // Prune what is older than the retention window: the live rows' totals carry over first, so the cumulative
        // live cap still counts them. Settle and release rows share their reservation's day, so a reservation and its
        // close go together.
        // Ordered by day first, so the day index serves it (ordering by seq alone would walk every live row).
        const pruned = q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE day < ? AND live = 1 ORDER BY day, seq`, keepFrom);
        if (pruned.length) {
          const t = totalsOf(fold(pruned).values());
          const carry = parseCarry(meta(META.liveCarry));
          setMeta(META.liveCarry, JSON.stringify({ settledMicros: carry.settledMicros + t.settledMicros, openMicros: carry.openMicros + t.openMicros, neurons: carry.neurons + t.neurons }));
        }
        s.sql.exec(`DELETE FROM spend_entries WHERE day < ?`, keepFrom);
        s.sql.exec(`DELETE FROM neuron_entries WHERE day < ?`, keepFrom);
        return settled;
      });
      for (const [e, r] of done) apply(e, r);
      return done.length;
    },
    recordNeurons({ product, model, neurons }) {
      const n = Math.max(0, Math.ceil(neurons));
      if (!n) return;
      const at = wallNow().toISOString();
      s.sql.exec(`INSERT INTO neuron_entries (at, day, product, model, neurons) VALUES (?, ?, ?, ?, ?)`, at, at.slice(0, 10), product, model, n);
      const st = days.get(at.slice(0, 10));
      if (st && product in st.direct) st.direct[product] += n;
    },
    neuronsLeft(product) {
      const use = neuronUse(current());
      const caps = opts.caps();
      return { product: Math.max(0, (shares[product] ?? 0) - use.byProduct[product]), day: Math.max(0, caps.neuronsDay - use.total) };
    },
    entries(day) {
      return rowsForDay(day ?? today());
    },
  };
}

function parseCarry(v: string | null): Totals {
  try {
    const t = v ? (JSON.parse(v) as Partial<Totals>) : {};
    return { settledMicros: Number(t.settledMicros) || 0, openMicros: Number(t.openMicros) || 0, neurons: Number(t.neurons) || 0 };
  } catch {
    return zeroTotals();
  }
}
