// SpendDO's ledger (design 4.1, 4.3, 5.2 and 6.3): `spend_entries` and `neuron_entries` in the SpendDO's own SQLite,
// never reset with a world. It keeps the file ledger's semantics (packages/agent/src/spend.ts): a reservation opens at
// its reserved amount, a settle replaces it, a release zeroes it, open reservations count as spent, settle and release
// rows copy the reservation's scope columns (so they land in its day), and the per-run cap keys a run by its world
// and its id. The hosted caps add the visitor and IP-hash day caps, the neuron day cap with per-product shares, a
// cumulative live cap that is off by default (section 0), and orphans settled at their reserved worst case after
// ORPHAN_SETTLE_MS. Reserve checks and inserts in one synchronous transaction, so two slots racing for the last cents
// of the day cap cannot both pass. Pure over SqlStorageLike: unit tests run it on node:sqlite.
//
// Rows read stay flat (design 8.2: DO rows read are an account-wide daily cap any visitor can spend), and they stay
// flat COLD: a Durable Object with no timers, I/O or WebSockets hibernates after about 10 s idle and drops its memory,
// so nothing here is kept in memory. Every day's fold (settled and open micros, open reservations, neurons, neurons by
// product with the direct neuron entries, and the same for live entries) is persisted in `spend_days`, one row per UTC
// day, updated in the same transactionSync as every write that changes it (reserve, settle, release, the orphan
// sweep's settles, direct neurons and pruning). A status, a day's totals and the live totals (GET /v1/agent/costs and
// the Platform page, which any visitor can call) read only those rows and the live carry, never an entry; a day
// outside the retained ones answers zero and reads nothing. The visitor and IP-hash day caps have their own persisted
// totals in `spend_who`, one row per day and visitor or address (settled and open micros), updated in the same
// transactions, so a reservation and a leased visitor's status read one row for each instead of that visitor's or
// that address's entries of the day. A reservation also reads its run's rows (the run cap). The orphan sweep reads
// only the reservations that crossed the orphan age since its last run, and prunes entries older than RETAIN_DAYS a
// bounded batch at a time, taking the batch's fold out of its day's rows (the live part carries over in spend_meta,
// so the cumulative live cap still counts it).
import {
  FROZEN_CAP, NEURON_SHARES, ORPHAN_SETTLE_MS,
  type HostedCap, type HostedCaps, type HostedReserveInput, type HostedReserveRefusal, type HostedSpendScope,
  type HostedSpendStatus, type NeuronProduct, type SqlStorageLike, type SqlStorageValue,
} from "../../shared/contracts";
import { randomHex } from "../../shared/crypto";

/**
 * "3" added `spend_who` (the persisted per-day totals of each visitor and IP hash) in place of the visitor and IP-hash
 * indexes; "2" added `spend_days` (the persisted per-day totals); "1" kept totals in memory. The speech neuron product
 * (the cursor assistant's spoken answers, 2026-10-24) only adds a `spend_days` column with a default, which code from
 * before it never names, so it is no new version: a rollback of weft-core still reads the ledger (addMissingDayColumns).
 */
export const SPEND_SCHEMA_VERSION = "3";

const PRODUCTS: readonly NeuronProduct[] = ["agent", "ocr", "embeddings", "dictation", "speech"];

/** The columns of a `spend_days` row: one UTC day's fold, as the file ledger folds it, plus its direct neurons. */
const DAY_COLS = [
  "settled_micros", "open_micros", "open_count", "neurons",
  "agent_neurons", "ocr_neurons", "embeddings_neurons", "dictation_neurons", "speech_neurons",
  "live_settled_micros", "live_open_micros", "live_neurons",
] as const;
type DayCol = (typeof DAY_COLS)[number];
/** One day's totals (or a change to them): every DAY_COLS column. */
export type DayTotals = Record<DayCol, number>;
const productCol = (p: NeuronProduct): DayCol => `${p}_neurons`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spend_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS spend_entries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, world TEXT, run_id TEXT,
     kind TEXT NOT NULL, reservation_id TEXT NOT NULL, usd_micros INTEGER NOT NULL, model TEXT NOT NULL,
     live INTEGER NOT NULL, visitor TEXT, ip_hash TEXT, neurons INTEGER NOT NULL DEFAULT 0, product TEXT)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_day ON spend_entries(day)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_rsv ON spend_entries(reservation_id)`,
  `CREATE INDEX IF NOT EXISTS spend_entries_run ON spend_entries(world, run_id) WHERE run_id IS NOT NULL`,
  // The orphan sweep's window of reservations by age.
  `CREATE INDEX IF NOT EXISTS spend_entries_reserve_at ON spend_entries(at) WHERE kind = 'reserve'`,
  `CREATE TABLE IF NOT EXISTS neuron_entries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, product TEXT NOT NULL,
     model TEXT NOT NULL, neurons INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS neuron_entries_day ON neuron_entries(day)`,
  `CREATE TABLE IF NOT EXISTS spend_days (day TEXT PRIMARY KEY, ${DAY_COLS.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(", ")}) WITHOUT ROWID`,
  // The visitor and IP-hash day caps: one row per day and visitor (kind 'v') or IP hash (kind 'i').
  `CREATE TABLE IF NOT EXISTS spend_who (day TEXT NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL, settled_micros INTEGER NOT NULL DEFAULT 0, open_micros INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, who)) WITHOUT ROWID`,
];
/** Schema 2's per-entry indexes for the visitor and IP-hash caps, which `spend_who` replaces (each cost two index
 * rows written per entry). */
const RETIRED_INDEXES = ["spend_entries_visitor", "spend_entries_ip"];

export interface SyncSql {
  readonly sql: SqlStorageLike;
  transactionSync<T>(fn: () => T): T;
}

/**
 * Creates the ledger's tables and indexes (IF NOT EXISTS, so a start creates nothing once they exist), adds any day
 * column a `spend_days` table from before it lacks (every start; CREATE TABLE IF NOT EXISTS adds no column to a table
 * that exists; zero for every earlier day, when nothing spoke), and upgrades an older ledger once, in one transaction
 * with the schema row: a schema 1 or 2 ledger gets its `spend_days` and `spend_who` rows built from the entries (each
 * read once, rebuildSpendTotals), and the indexes they replace are dropped (schema 1's live index, schema 2's visitor
 * and IP-hash indexes).
 */
export function migrateSpend(s: SyncSql): void {
  s.transactionSync(() => {
    for (const q of SCHEMA) s.sql.exec(q);
    addMissingDayColumns(s.sql);
    const v = s.sql.exec<{ v: string }>(`SELECT v FROM spend_meta WHERE k = 'schema'`).toArray()[0]?.v;
    if (v === SPEND_SCHEMA_VERSION) return;
    if (v === undefined) {
      s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES ('schema', ?)`, SPEND_SCHEMA_VERSION);
      return;
    }
    if (v !== "1" && v !== "2") throw new Error(`SpendDO schema ${v} is newer than this code (${SPEND_SCHEMA_VERSION})`);
    for (const ix of ["spend_entries_live", ...RETIRED_INDEXES]) s.sql.exec(`DROP INDEX IF EXISTS ${ix}`);
    rebuildTotalsNow(s.sql);
    s.sql.exec(`UPDATE spend_meta SET v = ? WHERE k = 'schema'`, SPEND_SCHEMA_VERSION);
  });
}

/**
 * Adds each DAY_COLS column an older `spend_days` lacks. Every start runs it: the table's columns come from PRAGMA
 * table_info (no row of any table is read, nothing is written), and the ALTER runs only for a column that is missing.
 */
function addMissingDayColumns(sql: SqlStorageLike): void {
  const have = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(spend_days)`).toArray().map((r) => r.name));
  for (const c of DAY_COLS) if (!have.has(c)) sql.exec(`ALTER TABLE spend_days ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
}

/**
 * Rebuilds every `spend_days` and `spend_who` row from the entries: each entry and direct neuron entry is read once
 * (the table holds RETAIN_DAYS of entries, since the sweep prunes older ones). An upgrade runs it once; tests run it
 * after writing entries directly. The live carry (pruned live totals) is kept as it is.
 */
export function rebuildSpendTotals(s: SyncSql): void {
  s.transactionSync(() => rebuildTotalsNow(s.sql));
}

function rebuildTotalsNow(sql: SqlStorageLike): void {
  const byDay = new Map<string, DayTotals>();
  const at = (day: string) => { let t = byDay.get(day); if (!t) { t = zeroDay(); byDay.set(day, t); } return t; };
  const byWho = new Map<string, { day: string; kind: WhoKind; who: string; t: WhoTotals }>();
  const rows = sql.exec(`SELECT ${ROW_COLS} FROM spend_entries ORDER BY seq`).toArray() as unknown as SpendRow[];
  for (const f of fold(rows).values()) {
    addInto(at(f.r.day), contribution(f));
    const w = whoContribution(f);
    for (const [kind, who] of whoOf(f.r)) {
      const k = `${f.r.day}|${kind}|${who}`;
      const cur = byWho.get(k) ?? { day: f.r.day, kind, who, t: { settled: 0, open: 0 } };
      cur.t.settled += w.settled;
      cur.t.open += w.open;
      byWho.set(k, cur);
    }
  }
  for (const d of sql.exec<{ day: string; product: string; n: number }>(`SELECT day, product, SUM(neurons) AS n FROM neuron_entries GROUP BY day, product`).toArray()) {
    if ((PRODUCTS as readonly string[]).includes(d.product)) at(d.day)[productCol(d.product as NeuronProduct)] += Number(d.n);
  }
  sql.exec(`DELETE FROM spend_days`);
  for (const [day, t] of byDay) addToDay(sql, day, t);
  sql.exec(`DELETE FROM spend_who`);
  for (const w of byWho.values()) addToWho(sql, w.day, w.kind, w.who, w.t);
}

/** `spend_who` kinds: a visitor's day, an IP hash's day. */
type WhoKind = "v" | "i";
/** A visitor's or an address's day totals (or a change to them). */
export interface WhoTotals { settled: number; open: number }
/** The `spend_who` rows a reservation counts in: its visitor's and its address's, as they are set. */
const whoOf = (r: Pick<SpendRow, "visitor" | "ip_hash">): [WhoKind, string][] =>
  [...(r.visitor ? [["v", r.visitor] as [WhoKind, string]] : []), ...(r.ip_hash ? [["i", r.ip_hash] as [WhoKind, string]] : [])];
/** What one folded reservation adds to its visitor's and its address's rows. */
const whoContribution = (f: Folded): WhoTotals => (f.open ? { settled: 0, open: f.micros } : { settled: f.micros, open: 0 });
/** Adds `t` to the visitor's or address's row of `day` (creating it), inside the caller's transaction; zeros write nothing. */
function addToWho(sql: SqlStorageLike, day: string, kind: WhoKind, who: string, t: WhoTotals): void {
  if (t.settled === 0 && t.open === 0) return;
  sql.exec(`INSERT INTO spend_who (day, kind, who, settled_micros, open_micros) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day, kind, who) DO UPDATE SET settled_micros = settled_micros + excluded.settled_micros, open_micros = open_micros + excluded.open_micros`,
  day, kind, who, t.settled, t.open);
}
/** Adds `t` to every `spend_who` row reservation `r` counts in. */
function addToWhoOf(sql: SqlStorageLike, r: SpendRow, t: WhoTotals): void {
  for (const [kind, who] of whoOf(r)) addToWho(sql, r.day, kind, who, t);
}
/** What closing reservation `r` with entry `e` changes in its visitor's and address's rows. */
const whoCloseChange = (r: SpendRow, e: SpendRow): WhoTotals => ({ settled: e.kind === "settle" ? e.usd_micros : 0, open: -r.usd_micros });

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

const zeroDay = (): DayTotals => Object.fromEntries(DAY_COLS.map((c) => [c, 0])) as DayTotals;
function addInto(into: DayTotals, d: DayTotals, sign = 1): DayTotals {
  for (const c of DAY_COLS) into[c] += sign * d[c];
  return into;
}
/** What one folded reservation adds to its day's row. */
function contribution(f: Folded): DayTotals {
  const t = zeroDay();
  if (f.open) { t.open_micros = f.micros; t.open_count = 1; } else t.settled_micros = f.micros;
  t.neurons = f.neurons;
  const p = f.r.product ?? "agent";
  if ((PRODUCTS as readonly string[]).includes(p)) t[productCol(p as NeuronProduct)] = f.neurons;
  if (f.r.live === 1) {
    t.live_settled_micros = t.settled_micros;
    t.live_open_micros = t.open_micros;
    t.live_neurons = f.neurons;
  }
  return t;
}
/** What closing reservation `r` with entry `e` changes in its day's row: the closed fold less the open one. */
function closeChange(r: SpendRow, e: SpendRow): DayTotals {
  const open = contribution({ r, micros: r.usd_micros, neurons: r.neurons, open: true });
  const closed = contribution({ r, micros: e.kind === "settle" ? e.usd_micros : 0, neurons: e.kind === "settle" ? e.neurons : 0, open: false });
  return addInto(closed, open, -1);
}
/** Adds `d` to `day`'s row (creating it), inside the caller's transaction; a change of all zeros writes nothing. */
function addToDay(sql: SqlStorageLike, day: string, d: DayTotals): void {
  if (DAY_COLS.every((c) => d[c] === 0)) return;
  sql.exec(
    `INSERT INTO spend_days (day, ${DAY_COLS.join(", ")}) VALUES (?, ${DAY_COLS.map(() => "?").join(", ")})
     ON CONFLICT (day) DO UPDATE SET ${DAY_COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`,
    day, ...DAY_COLS.map((c) => d[c]),
  );
}
const totalsOfDay = (t: DayTotals): Totals => ({ settledMicros: t.settled_micros, openMicros: t.open_micros, neurons: t.neurons });
const liveOfDay = (t: DayTotals): Totals => ({ settledMicros: t.live_settled_micros, openMicros: t.live_open_micros, neurons: t.live_neurons });
function addTotals(a: Totals, b: Totals, sign = 1): Totals {
  return { settledMicros: a.settledMicros + sign * b.settledMicros, openMicros: a.openMicros + sign * b.openMicros, neurons: a.neurons + sign * b.neurons };
}

/** Spend entries are kept this many UTC days back (today included); older ones are pruned by the orphan sweep. */
export const RETAIN_DAYS = 3;
const DAY_MS = 86_400_000;
/** The UTC days the ledger keeps at `now`: today first, then the RETAIN_DAYS - 1 days before it. */
export const retainedDays = (now: Date): string[] =>
  Array.from({ length: RETAIN_DAYS }, (_, i) => new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
/**
 * The orphan sweep prunes at most this many old reservations (each with its settle or release row) and this many old
 * direct neuron entries per run, so a backlog (a ledger that went unswept for days) is deleted over several sweeps,
 * never in one large write. At one sweep every 15 minutes that is 48,000 reservations a day.
 */
export const PRUNE_BATCH = 500;
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

function neuronUse(t: DayTotals): { total: number; byProduct: Record<NeuronProduct, number> } {
  const byProduct = Object.fromEntries(PRODUCTS.map((p) => [p, t[productCol(p)]])) as Record<NeuronProduct, number>;
  return { total: PRODUCTS.reduce((n, p) => n + byProduct[p], 0), byProduct };
}

export function createSqlSpendLedger(s: SyncSql, opts: SqlSpendLedgerOptions): SqlSpendLedger {
  const wallNow = opts.wallNow ?? (() => new Date());
  const shares = opts.neuronShares ?? NEURON_SHARES;
  const today = () => wallNow().toISOString().slice(0, 10);
  const q = <T>(query: string, ...b: SqlStorageValue[]): T[] => s.sql.exec(query, ...b).toArray() as unknown as T[];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

  const rowsForDay = (day: string) => q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE day = ? ORDER BY seq`, day);
  const rowsForRun = (world: string | null, runId: string) => world === null
    ? q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE world IS NULL AND run_id = ? ORDER BY seq`, runId)
    : q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE world = ? AND run_id = ? ORDER BY seq`, world, runId);
  /** A visitor's or an address's rows on `days` (through the day index), for a scope spend_who does not answer (a
   * visitor and an address together, or with a live filter): no deployed caller asks one. */
  const rowsFor = (days: readonly string[], who: { visitor?: string; ipHash?: string }) => {
    const where = [`day IN (${marks(days.length)})`];
    const b: SqlStorageValue[] = [...days];
    if (who.visitor !== undefined) { where.push("visitor = ?"); b.push(who.visitor); }
    if (who.ipHash !== undefined) { where.push("ip_hash = ?"); b.push(who.ipHash); }
    return q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE ${where.join(" AND ")} ORDER BY seq`, ...b);
  };
  const meta = (k: string): string | null => q<{ v: string }>(`SELECT v FROM spend_meta WHERE k = ?`, k)[0]?.v ?? null;
  const setMeta = (k: string, v: string) => s.sql.exec(`INSERT INTO spend_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);

  // Persisted totals ---------------------------------------------------------------------------------------------

  const DAY_SELECT = `SELECT day, ${DAY_COLS.join(", ")} FROM spend_days`;
  const asDay = (r: Record<string, unknown>): DayTotals => Object.fromEntries(DAY_COLS.map((c) => [c, Number(r[c]) || 0])) as DayTotals;
  /** `day`'s row (one row read), or zeros when the day has none. */
  const dayTotals = (day: string): DayTotals => {
    const r = q<Record<string, unknown>>(`${DAY_SELECT} WHERE day = ?`, day)[0];
    return r ? asDay(r) : zeroDay();
  };
  /** The rows of `days` added up (one row read per day that has one). */
  const daysTotals = (days: readonly string[]): DayTotals =>
    q<Record<string, unknown>>(`${DAY_SELECT} WHERE day IN (${marks(days.length)})`, ...days).reduce<DayTotals>((t, r) => addInto(t, asDay(r)), zeroDay());
  /** A visitor's or an address's committed micros on `days`: one `spend_who` row per day that has one. */
  const whoTotals = (days: readonly string[], kind: WhoKind, who: string): Totals =>
    q<{ s: number; o: number }>(`SELECT settled_micros AS s, open_micros AS o FROM spend_who WHERE day IN (${marks(days.length)}) AND kind = ? AND who = ?`, ...days, kind, who)
      .reduce<Totals>((t, r) => ({ settledMicros: t.settledMicros + (Number(r.s) || 0), openMicros: t.openMicros + (Number(r.o) || 0), neurons: 0 }), zeroTotals());
  /** Every live reservation ever made: the live carry (pruned ones) plus every day row's live part. Reads the carry and
   * the day rows: the retained days and the older ones the sweep has not pruned yet. */
  function live(): Totals {
    const sum = q<Record<string, unknown>>(`SELECT COALESCE(SUM(live_settled_micros), 0) AS s, COALESCE(SUM(live_open_micros), 0) AS o, COALESCE(SUM(live_neurons), 0) AS n FROM spend_days`)[0];
    return addTotals(parseCarry(meta(META.liveCarry)), { settledMicros: Number(sum?.s) || 0, openMicros: Number(sum?.o) || 0, neurons: Number(sum?.n) || 0 });
  }

  // Queries --------------------------------------------------------------------------------------------------------

  function scopeTotals(scope: HostedSpendScope): Totals {
    const keep = (r: SpendRow) =>
      (scope.day === undefined || r.day === scope.day)
      && (scope.live === undefined || (r.live === 1) === scope.live)
      && (scope.visitor === undefined || r.visitor === scope.visitor)
      && (scope.ipHash === undefined || r.ip_hash === scope.ipHash)
      && (scope.runId === undefined || scope.world === undefined || r.world === scope.world);
    // A run's totals read the run's own rows (through its index), and a visitor's or an address's its persisted rows on
    // the days asked for (micros only, as the caps use them). Everything else comes from the day rows: a retained
    // day's row, nothing for any other day (no query), the live totals, and otherwise the retained days together
    // (older entries are pruned, so they are the whole table but for what the next sweep prunes).
    if (scope.runId !== undefined) return totalsOf(fold(rowsForRun(scope.world ?? null, scope.runId)).values(), keep);
    const kept = retainedDays(wallNow());
    const days = scope.day === undefined ? kept : kept.includes(scope.day) ? [scope.day] : [];
    if (!days.length) return zeroTotals();
    const alone = scope.live === undefined && (scope.visitor === undefined) !== (scope.ipHash === undefined);
    if (alone && scope.visitor !== undefined) return whoTotals(days, "v", scope.visitor);
    if (alone && scope.ipHash !== undefined) return whoTotals(days, "i", scope.ipHash);
    if (scope.visitor !== undefined || scope.ipHash !== undefined) return totalsOf(fold(rowsFor(days, scope)).values(), keep);
    if (scope.day === undefined && scope.live === true) return live();
    const t = daysTotals(days);
    if (scope.live === true) return liveOfDay(t);
    if (scope.live === false) return addTotals(totalsOfDay(t), liveOfDay(t), -1);
    return totalsOfDay(t);
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

  /** Closes a reservation (a settle at `usd` and `neurons`, the reservation's own neurons when undefined, or a release)
   * and takes the change into its day's row, in one transaction. */
  function close(id: string, kind: "settle" | "release", usd: number, neurons: number | undefined): void {
    s.transactionSync(() => {
      const r = findReservation(id);
      if (!r || isClosed(id)) return;   // unknown, or already closed: a replayed settle changes nothing
      const e: SpendRow = { ...r, kind, usd_micros: Math.max(0, Math.ceil(usd)), neurons: Math.max(0, Math.ceil(neurons ?? r.neurons)) };
      insert(e);
      addToDay(s.sql, r.day, closeChange(r, e));
      addToWhoOf(s.sql, r, whoCloseChange(r, e));
    });
  }

  /**
   * Prunes what is older than the retained days, PRUNE_BATCH oldest reservations at a time, each with its close
   * (settle and release rows share their reservation's day and id), so a fold of the batch is the batch's whole
   * story: it is taken out of its days' rows, and its live part carries over into spend_meta, so the cumulative live
   * cap still counts it. Once no old reservation is left, the old rows still there (a close whose reservation is gone,
   * which the fold ignores) go too, as many at a time. Direct neuron entries are pruned PRUNE_BATCH at a time, each
   * taken out of its day's row. An old day left with no entry loses its row (any live part it still holds carries).
   */
  function prune(keepFrom: string): void {
    s.transactionSync(() => {
      let carry = zeroTotals();
      // Ordered by day first, so the day index serves it.
      const batch = `SELECT reservation_id FROM spend_entries WHERE day < ? AND kind = 'reserve' ORDER BY day, seq LIMIT ?`;
      const rows = q<SpendRow>(`SELECT ${ROW_COLS} FROM spend_entries WHERE reservation_id IN (${batch}) ORDER BY seq`, keepFrom, PRUNE_BATCH);
      const folded = fold(rows);
      // Each pruned reservation leaves its day's row (negative changes), and its live part moves to the carry.
      const out = new Map<string, DayTotals>();
      const change = (day: string) => { let t = out.get(day); if (!t) { t = zeroDay(); out.set(day, t); } return t; };
      for (const f of folded.values()) {
        const c = contribution(f);
        addInto(change(f.r.day), c, -1);
        carry = addTotals(carry, liveOfDay(c));
        const w = whoContribution(f);
        addToWhoOf(s.sql, f.r, { settled: -w.settled, open: -w.open });
      }
      if (rows.length) s.sql.exec(`DELETE FROM spend_entries WHERE reservation_id IN (${batch})`, keepFrom, PRUNE_BATCH);
      if (folded.size < PRUNE_BATCH) {
        s.sql.exec(`DELETE FROM spend_entries WHERE seq IN (SELECT seq FROM spend_entries WHERE day < ? ORDER BY day, seq LIMIT ?)`, keepFrom, PRUNE_BATCH);
      }
      const nbatch = `SELECT seq FROM neuron_entries WHERE day < ? ORDER BY day, seq LIMIT ?`;
      const direct = q<{ day: string; product: string; neurons: number }>(`SELECT day, product, neurons FROM neuron_entries WHERE seq IN (${nbatch})`, keepFrom, PRUNE_BATCH);
      for (const d of direct) {
        if ((PRODUCTS as readonly string[]).includes(d.product)) change(d.day)[productCol(d.product as NeuronProduct)] -= Number(d.neurons);
      }
      if (direct.length) s.sql.exec(`DELETE FROM neuron_entries WHERE seq IN (${nbatch})`, keepFrom, PRUNE_BATCH);
      for (const [day, t] of out) addToDay(s.sql, day, t);
      const empty = `day < ? AND NOT EXISTS (SELECT 1 FROM spend_entries WHERE spend_entries.day = spend_days.day)
        AND NOT EXISTS (SELECT 1 FROM neuron_entries WHERE neuron_entries.day = spend_days.day)`;
      for (const r of q<Record<string, unknown>>(`${DAY_SELECT} WHERE ${empty}`, keepFrom)) carry = addTotals(carry, liveOfDay(asDay(r)));
      s.sql.exec(`DELETE FROM spend_days WHERE ${empty}`, keepFrom);
      // A pruned day's visitor and address rows go once none of its entries is left (the batches took them to zero).
      s.sql.exec(`DELETE FROM spend_who WHERE day < ? AND NOT EXISTS (SELECT 1 FROM spend_entries WHERE spend_entries.day = spend_who.day)`, keepFrom);
      if (carry.settledMicros || carry.openMicros || carry.neurons) setMeta(META.liveCarry, JSON.stringify(addTotals(parseCarry(meta(META.liveCarry)), carry)));
    });
  }

  return {
    reserve(input) {
      return s.transactionSync((): ReserveResult => {
        const caps = opts.caps();
        const day = today();
        const st = dayTotals(day);
        const usd = Math.max(0, Math.ceil(input.usdMicros));
        const neurons = Math.max(0, Math.ceil(input.neurons ?? 0));
        const product: NeuronProduct = input.product ?? "agent";
        const world = input.world ?? null;
        const checks: { cap: HostedCap; capMicros: number; committed: () => number }[] = [];
        if (input.runId !== null) {
          const scale = Math.max(1, input.runCapScale ?? 1);
          checks.push({ cap: "run", capMicros: caps.runUsd * scale * 1e6, committed: () => committedOf(totalsOf(fold(rowsForRun(world, input.runId!)).values())) });
        }
        checks.push({ cap: "day", capMicros: caps.dayUsd * 1e6, committed: () => committedOf(totalsOfDay(st)) });
        if (input.live && caps.liveUsd !== null) checks.push({ cap: "live", capMicros: caps.liveUsd * 1e6, committed: () => committedOf(live()) });
        if (input.visitor) checks.push({ cap: "visitor", capMicros: caps.visitorDayUsd * 1e6, committed: () => committedOf(whoTotals([day], "v", input.visitor!)) });
        if (input.ipHash) checks.push({ cap: "ip", capMicros: caps.ipDayUsd * 1e6, committed: () => committedOf(whoTotals([day], "i", input.ipHash!)) });
        for (const c of checks) {
          const committed = c.committed();
          if (committed + usd > c.capMicros) {
            return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP[c.cap], hostedCap: c.cap, spentMicros: committed, capMicros: Math.round(c.capMicros) };
          }
        }
        if (neurons > 0) {
          const use = neuronUse(st);
          const share = shares[product] ?? 0;
          if (use.total + neurons > caps.neuronsDay || use.byProduct[product] + neurons > share) {
            return { ok: false, code: "BUDGET_EXCEEDED", cap: FROZEN_CAP.neurons, hostedCap: "neurons", spentMicros: use.total, capMicros: Math.min(caps.neuronsDay, share) };
          }
        }
        const reservationId = `rsv_${randomHex(8)}`;
        const row: SpendRow = {
          at: wallNow().toISOString(), day, world, run_id: input.runId, kind: "reserve", reservation_id: reservationId, usd_micros: usd,
          model: input.model, live: input.live ? 1 : 0, visitor: input.visitor ?? null, ip_hash: input.ipHash ?? null,
          neurons, product: neurons > 0 ? product : null,
        };
        insert(row);
        addToDay(s.sql, day, contribution({ r: row, micros: usd, neurons, open: true }));
        addToWhoOf(s.sql, row, { settled: 0, open: usd });
        return { ok: true, reservationId };
      });
    },
    settle(id, actual, extra) {
      close(id, "settle", actual, extra?.neurons);
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
      const st = dayTotals(day);
      return {
        day,
        caps,
        spentMicros: {
          day: committedOf(totalsOfDay(st)),
          visitor: scope.visitor ? committedOf(whoTotals([day], "v", scope.visitor)) : null,
          ip: scope.ipHash ? committedOf(whoTotals([day], "i", scope.ipHash)) : null,
          live: committedOf(live()),
        },
        neurons: (({ total, byProduct }) => ({ used: total, byProduct }))(neuronUse(st)),
        openReservations: st.open_count,
      };
    },
    settleOrphans(now = wallNow()) {
      const cutoff = new Date(now.getTime() - ORPHAN_SETTLE_MS).toISOString();
      const floor = new Date(now.getTime() - ORPHAN_LOOKBACK_MS).toISOString();
      const settled = s.transactionSync(() => {
        // Only reservations that crossed the orphan age since the last sweep: every older one was settled then, or
        // closed itself. The first sweep (and one after a long gap) looks back ORPHAN_LOOKBACK_MS.
        const scannedTo = meta(META.orphansScannedTo);
        const from = scannedTo !== null && scannedTo > floor ? scannedTo : floor;
        const open = from < cutoff ? q<SpendRow>(
          `SELECT ${ROW_COLS} FROM spend_entries r WHERE r.kind = 'reserve' AND r.at >= ? AND r.at < ?
             AND NOT EXISTS (SELECT 1 FROM spend_entries x WHERE x.reservation_id = r.reservation_id AND x.kind != 'reserve')
           ORDER BY r.seq`, from, cutoff) : [];
        for (const r of open) {
          const e: SpendRow = { ...r, kind: "settle" };   // worst case: the reserved amount and neurons
          insert(e);
          addToDay(s.sql, r.day, closeChange(r, e));
          addToWhoOf(s.sql, r, whoCloseChange(r, e));
        }
        if (scannedTo === null || cutoff > scannedTo) setMeta(META.orphansScannedTo, cutoff);
        return open.length;
      });
      prune(retainedDays(now).at(-1)!);
      return settled;
    },
    recordNeurons({ product, model, neurons }) {
      const n = Math.max(0, Math.ceil(neurons));
      if (!n) return;
      const at = wallNow().toISOString();
      s.transactionSync(() => {
        s.sql.exec(`INSERT INTO neuron_entries (at, day, product, model, neurons) VALUES (?, ?, ?, ?, ?)`, at, at.slice(0, 10), product, model, n);
        if (!(PRODUCTS as readonly string[]).includes(product)) return;
        const t = zeroDay();
        t[productCol(product)] = n;
        addToDay(s.sql, at.slice(0, 10), t);
      });
    },
    neuronsLeft(product) {
      const use = neuronUse(dayTotals(today()));
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
