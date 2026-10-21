// SpendDO's ledger (design 4.1, 4.3, 5.2 and 6.3): `spend_entries` and `neuron_entries` in the SpendDO's own SQLite,
// never reset. It keeps the file ledger's semantics (packages/agent/src/spend.ts): a reservation opens at its
// reserved amount, a settle replaces it, a release zeroes it, open reservations count as spent, settle and release
// rows copy the reservation's scope columns (so they land in its day), and the per-run cap keys a run by its world
// and its id. The hosted caps add the visitor and IP-hash day caps, the neuron day cap with per-product shares, a
// cumulative live cap that is off by default (section 0), and orphans settled at their reserved worst case after
// ORPHAN_SETTLE_MS. Reserve checks and inserts in one synchronous transaction, so two slots racing for the last cents
// of the day cap cannot both pass. Pure over SqlStorageLike: unit tests run it on node:sqlite.
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

/** The file ledger's fold: per reservation, open at its reserved amount until a settle or release closes it. */
export function fold(rows: readonly SpendRow[]): Map<string, Folded> {
  const m = new Map<string, Folded>();
  for (const e of rows) {
    if (e.kind === "reserve") m.set(e.reservation_id, { r: e, micros: e.usd_micros, neurons: e.neurons, open: true });
    else {
      const cur = m.get(e.reservation_id);
      if (!cur) continue;
      cur.micros = e.kind === "settle" ? e.usd_micros : 0;
      cur.neurons = e.kind === "settle" ? e.neurons : 0;
      cur.open = false;
    }
  }
  return m;
}

export interface Totals { settledMicros: number; openMicros: number; neurons: number }
const committedOf = (t: Totals) => t.settledMicros + t.openMicros;

function totalsOf(folded: Iterable<Folded>, keep: (r: SpendRow) => boolean = () => true): Totals {
  const t: Totals = { settledMicros: 0, openMicros: 0, neurons: 0 };
  for (const f of folded) {
    if (!keep(f.r)) continue;
    if (f.open) t.openMicros += f.micros;
    else t.settledMicros += f.micros;
    t.neurons += f.neurons;
  }
  return t;
}

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
  settleOrphans(now?: Date): number;
  /** Neurons used outside a reservation (OCR, embeddings, dictation): counted against the day cap and the product's share. */
  recordNeurons(input: { product: NeuronProduct; model: string; neurons: number }): void;
  /** Whether `neurons` more for `product` fit today. */
  neuronsLeft(product: NeuronProduct): { product: number; day: number };
  entries(day?: string): SpendRow[];
}

const ROW_COLS = "at, day, world, run_id, kind, reservation_id, usd_micros, model, live, visitor, ip_hash, neurons, product";

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
  const directNeurons = (day: string) => q<{ product: string; n: number }>(`SELECT product, SUM(neurons) AS n FROM neuron_entries WHERE day = ? GROUP BY product`, day);

  function neuronUse(day: string, dayFolded: Map<string, Folded>): { total: number; byProduct: Record<NeuronProduct, number> } {
    const byProduct: Record<NeuronProduct, number> = { agent: 0, ocr: 0, embeddings: 0, dictation: 0 };
    for (const f of dayFolded.values()) {
      if (!f.neurons) continue;
      const p = (f.r.product ?? "agent") as NeuronProduct;
      if (p in byProduct) byProduct[p] += f.neurons;
    }
    for (const d of directNeurons(day)) if (d.product in byProduct) byProduct[d.product as NeuronProduct] += Number(d.n);
    return { total: Object.values(byProduct).reduce((a, b) => a + b, 0), byProduct };
  }

  function rowsForScope(scope: HostedSpendScope): SpendRow[] {
    if (scope.runId !== undefined) return rowsForRun(scope.world ?? null, scope.runId);
    if (scope.day !== undefined) return rowsForDay(scope.day);
    if (scope.live) return rowsLive();
    return q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries ORDER BY seq`);
  }

  function scopeTotals(scope: HostedSpendScope): Totals {
    const folded = fold(rowsForScope(scope));
    return totalsOf(folded.values(), (r) =>
      (scope.day === undefined || r.day === scope.day)
      && (scope.live === undefined || (r.live === 1) === scope.live)
      && (scope.visitor === undefined || r.visitor === scope.visitor)
      && (scope.ipHash === undefined || r.ip_hash === scope.ipHash)
      && (scope.runId === undefined || scope.world === undefined || r.world === scope.world));
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
    s.transactionSync(() => {
      const r = findReservation(id);
      if (!r || isClosed(id)) return;   // unknown, or already closed: a replayed settle changes nothing
      insert({ ...r, kind, usd_micros: Math.max(0, Math.ceil(usd)), neurons: Math.max(0, Math.ceil(neurons)) });
    });
  }

  return {
    reserve(input) {
      return s.transactionSync((): ReserveResult => {
        const caps = opts.caps();
        const day = today();
        const usd = Math.max(0, Math.ceil(input.usdMicros));
        const neurons = Math.max(0, Math.ceil(input.neurons ?? 0));
        const product: NeuronProduct = input.product ?? "agent";
        const world = input.world ?? null;
        const dayFolded = fold(rowsForDay(day));
        const checks: { cap: HostedCap; capMicros: number; committed: () => number }[] = [];
        if (input.runId !== null) {
          const scale = Math.max(1, input.runCapScale ?? 1);
          checks.push({ cap: "run", capMicros: caps.runUsd * scale * 1e6, committed: () => committedOf(totalsOf(fold(rowsForRun(world, input.runId!)).values())) });
        }
        checks.push({ cap: "day", capMicros: caps.dayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values())) });
        if (input.live && caps.liveUsd !== null) {
          checks.push({ cap: "live", capMicros: caps.liveUsd * 1e6, committed: () => committedOf(totalsOf(fold(rowsLive()).values())) });
        }
        if (input.visitor) checks.push({ cap: "visitor", capMicros: caps.visitorDayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values(), (r) => r.visitor === input.visitor)) });
        if (input.ipHash) checks.push({ cap: "ip", capMicros: caps.ipDayUsd * 1e6, committed: () => committedOf(totalsOf(dayFolded.values(), (r) => r.ip_hash === input.ipHash)) });
        for (const c of checks) {
          const committed = c.committed();
          if (committed + usd > c.capMicros) {
            return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP[c.cap], hostedCap: c.cap, spentMicros: committed, capMicros: Math.round(c.capMicros) };
          }
        }
        if (neurons > 0) {
          const use = neuronUse(day, dayFolded);
          const share = shares[product] ?? 0;
          if (use.total + neurons > caps.neuronsDay || use.byProduct[product] + neurons > share) {
            return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP.neurons, hostedCap: "neurons", spentMicros: use.total, capMicros: Math.min(caps.neuronsDay, share) };
          }
        }
        const reservationId = `rsv_${randomHex(8)}`;
        insert({
          at: wallNow().toISOString(), day, world, run_id: input.runId, kind: "reserve", reservation_id: reservationId, usd_micros: usd,
          model: input.model, live: input.live ? 1 : 0, visitor: input.visitor ?? null, ip_hash: input.ipHash ?? null,
          neurons, product: neurons > 0 ? product : null,
        });
        return { ok: true, reservationId };
      });
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
      const day = today();
      const caps = opts.caps();
      const dayFolded = fold(rowsForDay(day));
      const all = [...dayFolded.values()];
      const use = neuronUse(day, dayFolded);
      return {
        day,
        caps,
        spentMicros: {
          day: committedOf(totalsOf(all)),
          visitor: scope.visitor ? committedOf(totalsOf(all, (r) => r.visitor === scope.visitor)) : null,
          ip: scope.ipHash ? committedOf(totalsOf(all, (r) => r.ip_hash === scope.ipHash)) : null,
          live: committedOf(totalsOf(fold(rowsLive()).values())),
        },
        neurons: { used: use.total, byProduct: use.byProduct },
        openReservations: all.filter((f) => f.open).length,
      };
    },
    settleOrphans(now = wallNow()) {
      const cutoff = new Date(now.getTime() - ORPHAN_SETTLE_MS).toISOString();
      const since = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
      return s.transactionSync(() => {
        const open = q<SpendRow>(
          `SELECT ${ROW_COLS} FROM spend_entries r WHERE r.day >= ? AND r.kind = 'reserve' AND r.at < ?
             AND NOT EXISTS (SELECT 1 FROM spend_entries x WHERE x.reservation_id = r.reservation_id AND x.kind != 'reserve')
           ORDER BY r.seq`, since, cutoff);
        for (const r of open) insert({ ...r, kind: "settle" });   // worst case: the reserved amount and neurons
        return open.length;
      });
    },
    recordNeurons({ product, model, neurons }) {
      const n = Math.max(0, Math.ceil(neurons));
      if (!n) return;
      const at = wallNow().toISOString();
      s.sql.exec(`INSERT INTO neuron_entries (at, day, product, model, neurons) VALUES (?, ?, ?, ?, ?)`, at, at.slice(0, 10), product, model, n);
    },
    neuronsLeft(product) {
      const day = today();
      const use = neuronUse(day, fold(rowsForDay(day)));
      const caps = opts.caps();
      return { product: Math.max(0, (shares[product] ?? 0) - use.byProduct[product]), day: Math.max(0, caps.neuronsDay - use.total) };
    },
    entries(day) {
      return rowsForDay(day ?? today());
    },
  };
}
