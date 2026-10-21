// Test doubles for the bindings Miniflare does not emulate (Workers AI, Vectorize, Browser Run, Images, AI Search)
// and quick in-memory ones for R2 and KV, plus a D1 over node:sqlite with the real apps/cf/d1 migrations applied.
// Used by packages/cf-extras/test and apps/cf/test/extras. Track cf6-extras.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AiSearchChunkLike, AiSearchLike, BrowserLauncher, BrowserRequestLike, D1Like, D1PreparedLike, D1ResultLike, ImagesLike, KvLike, PageLike, R2BucketLike,
  R2ObjectBodyLike, VectorizeLike, VectorizeMatchLike, VectorizeVectorLike, WorkersAiBindingLike,
} from "../src/bindings";

export const D1_DIR = join(import.meta.dirname, "..", "..", "..", "apps", "cf", "d1");

// D1 --------------------------------------------------------------------------------------------------------------

const norm = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue));

export interface D1Shim extends D1Like { sqlite: DatabaseSync; statements: string[]; rows(table: string): Record<string, unknown>[] }

export function d1Shim(): D1Shim {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(D1_DIR).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(D1_DIR, f), "utf8"));
  const statements: string[] = [];
  const prep = (sql: string, params: unknown[] = []): D1PreparedLike & { exec(): D1ResultLike } => {
    const exec = (): D1ResultLike => {
      statements.push(sql);
      const st = db.prepare(sql);
      if (/^\s*(select|with)\b/i.test(sql)) return { results: st.all(...params.map(norm)) as Record<string, unknown>[] };
      const r = st.run(...params.map(norm));
      return { results: [], meta: { changes: Number(r.changes) } };
    };
    return {
      bind: (...v: unknown[]) => prep(sql, v),
      run: async () => exec(),
      all: async <T>() => exec() as D1ResultLike<T>,
      first: async <T>() => ((exec().results[0] as T | undefined) ?? null),
      exec,
    };
  };
  return {
    sqlite: db,
    statements,
    prepare: (sql) => prep(sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as ReturnType<typeof prep>).exec());
        db.exec("COMMIT");
        return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    rows: (table) => db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
  };
}

// KV and R2 -----------------------------------------------------------------------------------------------------

export function memoryKv(values: Record<string, string> = {}): KvLike & { values: Record<string, string>; reads: number } {
  const kv = { values, reads: 0, async get(k: string) { kv.reads++; return values[k] ?? null; } };
  return kv;
}

export function memoryR2(): R2BucketLike & { objects: Map<string, { bytes: Uint8Array; contentType?: string; meta?: Record<string, string> }>; puts: number; gets: number } {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string; meta?: Record<string, string> }>();
  const r2 = {
    objects, puts: 0, gets: 0,
    async head(key: string) { const o = objects.get(key); return o ? { key, size: o.bytes.length, httpMetadata: { contentType: o.contentType }, customMetadata: o.meta } : null; },
    async get(key: string): Promise<R2ObjectBodyLike | null> {
      r2.gets++;
      const o = objects.get(key);
      return o ? { key, size: o.bytes.length, httpMetadata: { contentType: o.contentType }, customMetadata: o.meta, arrayBuffer: async () => o.bytes.slice().buffer } : null;
    },
    async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      r2.puts++;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType, meta: opts?.customMetadata });
      return {};
    },
  };
  return r2;
}

// Workers AI ----------------------------------------------------------------------------------------------------

export interface AiCall { model: string; inputs: Record<string, unknown>; options?: unknown }
export function fakeAi(handlers: Record<string, (inputs: Record<string, unknown>) => unknown>): WorkersAiBindingLike & { calls: AiCall[] } {
  const calls: AiCall[] = [];
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs, options });
      const h = handlers[model];
      if (!h) throw new Error(`fake AI: no handler for ${model}`);
      return h(inputs);
    },
  };
}

/** A deterministic 768-dim bag-of-words embedding: texts sharing words get a high cosine score. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(768).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[Math.abs(h) % 768]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export const embeddingHandler = (inputs: Record<string, unknown>) => {
  const texts = inputs.text as string[];
  return { shape: [texts.length, 768], data: texts.map(fakeEmbedding) };
};

// Vectorize -----------------------------------------------------------------------------------------------------

export function fakeVectorize(): VectorizeLike & { vectors: Map<string, VectorizeVectorLike>; queries: { namespace?: string; filter?: unknown }[] } {
  const vectors = new Map<string, VectorizeVectorLike>();
  const queries: { namespace?: string; filter?: unknown }[] = [];
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  const matches = (md: Record<string, unknown>, filter: Record<string, unknown> | undefined) => !filter || Object.entries(filter).every(([k, cond]) => {
    const v = md[k];
    if (cond && typeof cond === "object") {
      const c = cond as { $eq?: unknown; $ne?: unknown; $in?: unknown[] };
      if ("$eq" in c && v !== c.$eq) return false;
      if ("$ne" in c && v === c.$ne) return false;
      if (c.$in && !c.$in.includes(v)) return false;
      return true;
    }
    return v === cond;
  });
  return {
    vectors, queries,
    async query(vector, o) {
      queries.push({ namespace: o.namespace, filter: o.filter });
      const ms: VectorizeMatchLike[] = [...vectors.values()]
        .filter((x) => (x.namespace ?? "") === (o.namespace ?? "") && matches(x.metadata ?? {}, o.filter as Record<string, unknown> | undefined))
        .map((x) => ({ id: x.id, score: cos(vector, x.values), namespace: x.namespace, metadata: o.returnMetadata === "none" ? undefined : x.metadata }))
        .sort((a, b) => b.score - a.score).slice(0, o.topK);
      return { matches: ms, count: ms.length };
    },
    async upsert(vs) { for (const v of vs) vectors.set(v.id, v); return { count: vs.length }; },
    async deleteByIds(ids) { for (const id of ids) vectors.delete(id); return { count: ids.length }; },
  };
}

// Images --------------------------------------------------------------------------------------------------------

export const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
export const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

export function fakeImages(opts: { fail?: boolean } = {}): ImagesLike & { transforms: unknown[] } {
  const transforms: unknown[] = [];
  return {
    transforms,
    input() {
      const t = {
        transform(x: unknown) { transforms.push(x); return t; },
        async output(o: { format: string }) {
          if (opts.fail) throw Object.assign(new Error("ImagesError 9412: not an image"), { code: 9412 });
          transforms.push(o);
          return { contentType: () => o.format, image: () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(TINY_JPEG); c.close(); } }) };
        },
      };
      return t;
    },
  };
}

// Browser Run ---------------------------------------------------------------------------------------------------

export interface BrowserLog {
  launches: number;
  jsEnabledAtContent: boolean | null;
  interceptionAtContent: boolean | null;
  requests: { url: string; aborted: boolean; continued: boolean }[];
  contents: string[];
  closed: number;
}

/**
 * A fake browser whose page "loads" the HTML: each src, href, url(...) and @import the HTML names becomes a request
 * event, and so does every URL in `extraRequests` (as a page script or a redirect would). A request a handler does not
 * abort counts as allowed, which the tests forbid.
 */
export function fakeBrowser(opts: { extraRequests?: string[]; failPdf?: boolean; msPerRender?: number; clock?: { t: number } } = {}): { launch: BrowserLauncher; log: BrowserLog } {
  const log: BrowserLog = { launches: 0, jsEnabledAtContent: null, interceptionAtContent: null, requests: [], contents: [], closed: 0 };
  const launch: BrowserLauncher = async () => {
    log.launches++;
    return {
      async newPage(): Promise<PageLike> {
        let js = true;
        let intercept = false;
        const handlers: ((r: BrowserRequestLike) => void)[] = [];
        return {
          async setJavaScriptEnabled(b) { js = b; },
          async setRequestInterception(b) { intercept = b; },
          on(_evt, h) { handlers.push(h); return undefined; },
          async setContent(html) {
            log.jsEnabledAtContent = js;
            log.interceptionAtContent = intercept;
            log.contents.push(html);
            const urls = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"|url\(([^)]+)\)|@import\s+"([^"]+)"/g)].map((m) => (m[1] ?? m[2] ?? m[3])!).concat(opts.extraRequests ?? []);
            for (const url of urls) {
              const rec = { url, aborted: false, continued: false };
              log.requests.push(rec);
              const req: BrowserRequestLike = { url: () => url, async abort() { rec.aborted = true; } };
              if (!intercept) { rec.continued = true; continue; }
              for (const h of handlers) h(req);
              await Promise.resolve();
              if (!rec.aborted) rec.continued = true;
            }
            if (opts.clock) opts.clock.t += opts.msPerRender ?? 3300;
          },
          async pdf() {
            if (opts.failPdf) throw new Error("Protocol error: Target closed");
            return new TextEncoder().encode("%PDF-1.7\n% fake pdf from the test browser\n%%EOF\n");
          },
          async close() { /* page */ },
        };
      },
      async close() { log.closed++; },
    };
  };
  return { launch, log };
}

// AI Search -----------------------------------------------------------------------------------------------------

export function fakeAiSearch(chunks: AiSearchChunkLike[] | ((q: string) => AiSearchChunkLike[])): AiSearchLike & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(p) { queries.push(p.query); return { search_query: p.query, chunks: typeof chunks === "function" ? chunks(p.query) : chunks }; },
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
