// The showcase memo (design 4.5): the showcase is immutable per snapshot, so the front keeps an in-isolate copy of its
// GET responses keyed by path, query, principal and snapshot version, bounded at 4 MB. A hit costs a Worker request
// but no Durable Object request and no rows read. Only 200 responses are kept, never a stream, never one the slot
// marks `cache-control: no-store` (a route that read a source outside the company database).
//
// The key is normalized (ResponseMemo.normalize) and the showcase is asked exactly the normalized request, so nothing
// a client adds can turn a hit into a miss:
// - query parameters the API never reads (MEMO_QUERY_PARAMS) are dropped, the ones it reads are sorted with their
//   first value, and an x-weft-principal that is not a persona id is dropped;
// - per path, the memo learns which of them the matched route actually reads (the world names them in x-weft-query)
//   and keeps only those, so an allowlisted parameter the route ignores (`/v1/workers?q=<counter>`) cannot vary the
//   key either. The key names the parameter set it was built with, so an entry is only ever served to a request that
//   agrees with it on every parameter its route read. A request whose route turns out to read a parameter the learned
//   set had dropped is asked again with every known parameter (normalize with no learned set);
// - free values (a search text, a date range, a random id in the path) can still make new keys, so the misses each
//   path family may cause are capped per window (admitMiss): MEMO_MISSES_PER_FAMILY distinct keys per
//   MEMO_MISS_WINDOW_MS for each `/v1/<family>`, and MEMO_FREE_TEXT_MISSES for keys that carry a search text
//   (MEMO_FREE_TEXT_PARAMS). Past it the front answers 429 instead of asking the showcase. The showcase's own daily
//   rows-read cap (CompanyDO) is the backstop behind this.

import { QUERY_HEADER } from "../shared/contracts";

export const MEMO_MAX_BYTES = 4 * 1024 * 1024;
export const MEMO_MAX_ENTRY_BYTES = 512 * 1024;
const KEEP_HEADERS = ["content-type", "etag", "x-weft-tables", "cache-control"];

/**
 * The query parameters apps/api's GET routes read (c.req.query, the routes' q(c, ...) helpers, the hosted layer's
 * `wait`). The unit suite scans apps/api/src and fails when a route reads one that is missing here.
 */
export const MEMO_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "afterId", "approver", "asOf", "at", "band", "beforeId", "category", "channel", "courseCode", "day", "departmentId", "detail",
  "folders", "form", "from", "group", "groupBy", "group_by", "include", "jurisdiction", "kind", "limit", "month", "offerId",
  "order", "path", "period", "policyId", "prefix", "q", "runId", "source", "state", "status", "surface", "to", "type",
  "vendor", "wait", "windowId", "workerId", "year",
]);
/** A query value longer than this is dropped (no route takes one). */
export const MEMO_MAX_QUERY_VALUE = 256;
/** Search texts: any value is a new key, so their misses have a cap of their own. */
export const MEMO_FREE_TEXT_PARAMS: ReadonlySet<string> = new Set(["q"]);
/** The window over which misses are counted, and the distinct missed keys each window allows. */
export const MEMO_MISS_WINDOW_MS = 60_000;
export const MEMO_MISSES_PER_FAMILY = 30;
export const MEMO_FREE_TEXT_MISSES = 10;
/** How long the showcase's GET /api/v1/health answer is reused: its clock is frozen and its world changes only with a
 * restore (a new snapshot is a new key), but the provider it names follows KV within the config memo's minute. */
export const HEALTH_MEMO_MS = 60_000;
/** Paths whose read parameters the memo remembers (least recently used first out). */
export const MEMO_MAX_LEARNED_PATHS = 2_048;
/** "Viewing as" principals: the admin personas (usr_dana) and the portal's employee personas (usr_ and digits). */
const PERSONA_RE = /^usr_(?:[a-z]{1,16}|\d{1,6})$/;

export interface MemoRequest { path: string; search: string; principal: string | null; snapshot: string }
/**
 * The memo key, the query and principal the showcase is asked with (null: no x-weft-principal header), and the
 * request's known parameters a learned set left out (`dropped`): if the route reads one of those after all, the read
 * is asked again without the learned set.
 */
export interface NormalizedRead { key: string; search: string; principal: string | null; dropped: string[]; freeText: boolean }
/** What a route reads: the names, or every known parameter ("*", or nothing learned yet). */
export type ReadSet = ReadonlySet<string> | null;

interface Entry { body: ArrayBuffer; headers: [string, string][]; status: number; at: number }

/** The parameter names a world's response says its route read: a set, or null for all of them (or no header). */
export function readNames(res: Response): ReadSet {
  const h = res.headers.get(QUERY_HEADER);
  if (h === null || h.trim() === "*") return null;
  return new Set(h.split(",").map((s) => s.trim()).filter(Boolean));
}

const familyOf = (path: string): string => path.split("/").slice(0, 3).join("/");

export class ResponseMemo {
  private readonly map = new Map<string, Entry>();
  private readonly learned = new Map<string, ReadSet>();
  private readonly windows = new Map<string, { start: number; keys: Set<string> }>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  refused = 0;

  constructor(private readonly maxBytes = MEMO_MAX_BYTES, private readonly maxEntry = MEMO_MAX_ENTRY_BYTES) {}

  /** The key: snapshot, principal, path, the parameter set it was built with ("*": every known one), and the query. */
  static key(input: MemoRequest & { reads?: ReadSet }): string {
    const tag = input.reads ? [...input.reads].sort().join(",") : "*";
    return `${input.snapshot}|${input.principal ?? "-"}|${input.path}|${tag}${input.search}`;
  }

  /**
   * The normalized read: known parameters only (and of those, only the ones `reads` names when the route's set is
   * learned), sorted, first value each; a principal only when it is a persona id.
   */
  static normalize(input: MemoRequest & { reads?: ReadSet }): NormalizedRead {
    const reads = input.reads ?? null;
    const params = new URLSearchParams(input.search);
    const kept: [string, string][] = [];
    const dropped: string[] = [];
    for (const name of [...new Set(params.keys())].filter((n) => MEMO_QUERY_PARAMS.has(n)).sort()) {
      const value = params.get(name)!;
      if (value.length > MEMO_MAX_QUERY_VALUE) continue;
      if (reads && !reads.has(name)) { dropped.push(name); continue; }
      kept.push([name, value]);
    }
    const search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    const principal = input.principal !== null && PERSONA_RE.test(input.principal) ? input.principal : null;
    const freeText = kept.some(([n, v]) => MEMO_FREE_TEXT_PARAMS.has(n) && v.trim() !== "");
    return { key: ResponseMemo.key({ ...input, search, principal, reads }), search, principal, dropped, freeText };
  }

  /** The parameters the route for `path` was seen to read, or null (every known one: not learned, or it reads all). */
  readsFor(path: string): ReadSet {
    const r = this.learned.get(path);
    if (r === undefined) return null;
    this.learned.delete(path);
    this.learned.set(path, r);
    return r;
  }

  /** Whether the route for `path` has a learned set yet. */
  hasLearned(path: string): boolean {
    return this.learned.has(path);
  }

  /**
   * Adds what one response said its route read to the path's set and returns the set: it only grows (a route can
   * read a parameter only for some values of another), and "all of them" stays all of them.
   */
  learn(path: string, names: ReadSet): ReadSet {
    const prev = this.learned.has(path) ? this.learned.get(path)! : undefined;
    const next: ReadSet = names === null || prev === null ? null : new Set([...(prev ?? []), ...names]);
    this.learned.delete(path);
    this.learned.set(path, next);
    while (this.learned.size > MEMO_MAX_LEARNED_PATHS) this.learned.delete(this.learned.keys().next().value!);
    return next;
  }

  /**
   * Whether a miss for `read` may go to the showcase now: each path family allows MEMO_MISSES_PER_FAMILY distinct
   * missed keys per window, and keys with a search text MEMO_FREE_TEXT_MISSES more of their own. A key already
   * missed in this window (concurrent requests, or a response the memo cannot keep) does not count again.
   */
  admitMiss(path: string, read: NormalizedRead, now = Date.now()): boolean {
    const take = (bucket: string, cap: number) => {
      let w = this.windows.get(bucket);
      if (!w || now - w.start >= MEMO_MISS_WINDOW_MS || now < w.start) { w = { start: now, keys: new Set() }; this.windows.set(bucket, w); }
      if (w.keys.has(read.key)) return true;
      if (w.keys.size >= cap) return false;
      w.keys.add(read.key);
      return true;
    };
    const ok = read.freeText ? take(`q:${familyOf(path)}`, MEMO_FREE_TEXT_MISSES) : take(familyOf(path), MEMO_MISSES_PER_FAMILY);
    if (!ok) this.refused += 1;
    // Families are the routes' first segments, so the window map stays small; a sweep keeps it so anyway.
    if (this.windows.size > 512) for (const [k, w] of this.windows) if (now - w.start >= MEMO_MISS_WINDOW_MS) this.windows.delete(k);
    return ok;
  }

  /** A copy of the entry, or null; `maxAgeMs` refuses an older one (the health answer is reused only so long). */
  get(key: string, maxAgeMs?: number, now = Date.now()): Response | null {
    const e = this.map.get(key);
    if (!e || (maxAgeMs !== undefined && now - e.at >= maxAgeMs)) { this.misses += 1; return null; }
    this.map.delete(key);
    this.map.set(key, e);   // most recently used last
    this.hits += 1;
    const headers = new Headers(e.headers);
    headers.set("x-weft-memo", "hit");
    return new Response(e.body.slice(0), { status: e.status, headers });
  }

  /** Stores a copy when it is memoizable and returns the response to send (the original body is consumed). */
  async put(key: string, res: Response, now = Date.now()): Promise<Response> {
    if (!ResponseMemo.memoizable(res)) return res;
    const body = await res.arrayBuffer();
    const headers: [string, string][] = KEEP_HEADERS.flatMap((h) => { const v = res.headers.get(h); return v === null ? [] : [[h, v] as [string, string]]; });
    if (body.byteLength <= this.maxEntry) {
      const prev = this.map.get(key);
      if (prev) { this.bytes -= prev.body.byteLength; this.map.delete(key); }
      this.map.set(key, { body, headers, status: res.status, at: now });
      this.bytes += body.byteLength;
      while (this.bytes > this.maxBytes && this.map.size) {
        const [oldest, e] = this.map.entries().next().value as [string, Entry];
        this.map.delete(oldest);
        this.bytes -= e.body.byteLength;
      }
    }
    const out = new Headers(res.headers);
    out.set("x-weft-memo", "miss");
    return new Response(body, { status: res.status, headers: out });
  }

  static memoizable(res: Response): boolean {
    if (res.status !== 200) return false;
    const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
    if (cc.includes("no-store")) return false;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/event-stream")) return false;
    const len = Number(res.headers.get("content-length") ?? "0");
    return !(len > MEMO_MAX_ENTRY_BYTES);
  }

  get size(): { entries: number; bytes: number; learned: number } {
    return { entries: this.map.size, bytes: this.bytes, learned: this.learned.size };
  }

  clear(): void {
    this.map.clear();
    this.learned.clear();
    this.windows.clear();
    this.bytes = 0;
  }
}
