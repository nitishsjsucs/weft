// The showcase memo (design 4.5): the showcase is immutable per snapshot, so the front keeps an in-isolate copy of its
// GET responses keyed by path, query, principal and snapshot version, bounded at 4 MB. A hit costs a Worker request
// but no Durable Object request and no rows read. Only 200 responses are kept, never a stream, never one the slot
// marks `cache-control: no-store` (a route that read a source outside the company database).
//
// The key is normalized (ResponseMemo.normalize) and the showcase is asked exactly the normalized request, so nothing
// a client adds can turn a hit into a miss: query parameters the API never reads are dropped, the ones it reads are
// sorted with their first value, and an x-weft-principal that is not a persona id is dropped. The key and the request
// the world answered are always the same, so a dropped parameter can never make the memo serve another answer.

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
/** "Viewing as" principals: the admin personas (usr_dana) and the portal's employee personas (usr_ and digits). */
const PERSONA_RE = /^usr_(?:[a-z]{1,16}|\d{1,6})$/;

export interface MemoRequest { path: string; search: string; principal: string | null; snapshot: string }
/** The memo key, and the query and principal the showcase is asked with (null: no x-weft-principal header). */
export interface NormalizedRead { key: string; search: string; principal: string | null }

interface Entry { body: ArrayBuffer; headers: [string, string][]; status: number }

export class ResponseMemo {
  private readonly map = new Map<string, Entry>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly maxBytes = MEMO_MAX_BYTES, private readonly maxEntry = MEMO_MAX_ENTRY_BYTES) {}

  static key(input: MemoRequest): string {
    return `${input.snapshot}|${input.principal ?? "-"}|${input.path}${input.search}`;
  }

  /** The normalized read: known parameters only, sorted, first value each; a principal only when it is a persona id. */
  static normalize(input: MemoRequest): NormalizedRead {
    const params = new URLSearchParams(input.search);
    const kept: [string, string][] = [];
    for (const name of [...new Set(params.keys())].filter((n) => MEMO_QUERY_PARAMS.has(n)).sort()) {
      const value = params.get(name)!;
      if (value.length <= MEMO_MAX_QUERY_VALUE) kept.push([name, value]);
    }
    const search = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    const principal = input.principal !== null && PERSONA_RE.test(input.principal) ? input.principal : null;
    return { key: ResponseMemo.key({ ...input, search, principal }), search, principal };
  }

  get(key: string): Response | null {
    const e = this.map.get(key);
    if (!e) { this.misses += 1; return null; }
    this.map.delete(key);
    this.map.set(key, e);   // most recently used last
    this.hits += 1;
    const headers = new Headers(e.headers);
    headers.set("x-weft-memo", "hit");
    return new Response(e.body.slice(0), { status: e.status, headers });
  }

  /** Stores a copy when it is memoizable and returns the response to send (the original body is consumed). */
  async put(key: string, res: Response): Promise<Response> {
    if (!ResponseMemo.memoizable(res)) return res;
    const body = await res.arrayBuffer();
    const headers: [string, string][] = KEEP_HEADERS.flatMap((h) => { const v = res.headers.get(h); return v === null ? [] : [[h, v] as [string, string]]; });
    if (body.byteLength <= this.maxEntry) {
      const prev = this.map.get(key);
      if (prev) { this.bytes -= prev.body.byteLength; this.map.delete(key); }
      this.map.set(key, { body, headers, status: res.status });
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

  get size(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.bytes };
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
