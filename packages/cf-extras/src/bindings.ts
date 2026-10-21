// Structural types for the Cloudflare bindings the extras use (design 3.1 and 7.1). Typed by shape, not by
// @cloudflare/workers-types, so the code runs over the real bindings in workerd, over Miniflare's local D1, KV, R2
// and Queues, and over the fakes the tests use for the bindings Miniflare does not emulate (Workers AI, Vectorize,
// Browser Run, Images, AI Search). Track cf6-extras.
import type { WorkersAiBindingLike } from "../../contracts/src/ext/cf-agent";

export type { WorkersAiBindingLike };

/** The gateway option every Workers AI call passes (design 5.1): logs, cache and rate limits in AI Gateway `weft`. */
export type AiGatewayOption = { id: string; metadata?: Record<string, string | number | boolean | null> };

// D1 --------------------------------------------------------------------------------------------------------------

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  meta?: { changes?: number; rows_read?: number; rows_written?: number };
}
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<D1ResultLike>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
/** D1 `weft-ops` (design 4.1): off the data path, so a statement per call and `batch()` as the only transaction. */
export interface D1Like {
  prepare(query: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<D1ResultLike[]>;
}

// KV, R2, Queues ----------------------------------------------------------------------------------------------------

export interface KvLike { get(key: string): Promise<string | null> }

export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { contentType?: string };
  readonly customMetadata?: Record<string, string>;
}
export interface R2ObjectBodyLike extends R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer> }
export interface R2PutOptionsLike { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: R2PutOptionsLike): Promise<unknown>;
}

export interface QueueLike<T = unknown> { send(body: T, options?: { contentType?: "json"; delaySeconds?: number }): Promise<unknown> }

export interface QueueMessageLike<T = unknown> {
  readonly id: string;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}
export interface MessageBatchLike<T = unknown> { readonly queue: string; readonly messages: readonly QueueMessageLike<T>[] }

// Vectorize ---------------------------------------------------------------------------------------------------------

export type VectorMetadataValue = string | number | boolean;
export interface VectorizeMatchLike { id: string; score: number; namespace?: string; metadata?: Record<string, unknown> }
export interface VectorizeQueryOptionsLike {
  topK: number;
  namespace?: string;
  returnMetadata?: "all" | "indexed" | "none";
  returnValues?: boolean;
  filter?: Record<string, VectorMetadataValue | { $eq?: VectorMetadataValue; $ne?: VectorMetadataValue; $in?: VectorMetadataValue[] }>;
}
export interface VectorizeVectorLike { id: string; values: number[]; namespace?: string; metadata?: Record<string, VectorMetadataValue> }
/** Vectorize `weft-memory` (768 dims, cosine; metadata indexes on gen, tainted and kind). */
export interface VectorizeLike {
  query(vector: number[], options: VectorizeQueryOptionsLike): Promise<{ matches: VectorizeMatchLike[]; count?: number }>;
  upsert(vectors: VectorizeVectorLike[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

// Images --------------------------------------------------------------------------------------------------------------

export interface ImageTransformLike { width?: number; height?: number; fit?: "scale-down" | "contain" | "cover" | "crop" | "pad" }
export interface ImageResultLike { image(): ReadableStream<Uint8Array>; contentType(): string }
export interface ImageTransformerLike {
  transform(t: ImageTransformLike): ImageTransformerLike;
  output(o: { format: "image/jpeg" | "image/png" | "image/webp"; quality?: number }): Promise<ImageResultLike>;
}
/** The Images binding: receipt photos are normalized to at most OCR_MAX_EDGE_PX before OCR (design 5.4). */
export interface ImagesLike { input(stream: ReadableStream<Uint8Array>): ImageTransformerLike }

// Browser Run -------------------------------------------------------------------------------------------------------

export interface BrowserRequestLike { url(): string; abort(errorCode?: string): Promise<void> }
export interface PageLike {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: "request", handler: (request: BrowserRequestLike) => void): unknown;
  setContent(html: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0"; timeout?: number }): Promise<void>;
  pdf(options?: { format?: "letter" | "a4"; printBackground?: boolean; margin?: Record<string, string>; timeout?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface BrowserLike { newPage(): Promise<PageLike>; close(): Promise<void> }
/** `(await import("@cloudflare/puppeteer")).default.launch(env.BROWSER)` in production; a fake in tests. */
export type BrowserLauncher = () => Promise<BrowserLike>;

// AI Search ---------------------------------------------------------------------------------------------------------

export interface AiSearchChunkLike {
  id: string;
  score: number;
  text: string;
  item: { key: string; metadata?: Record<string, unknown> };
}
/** The `ai_search` instance binding (`weft-help` over R2 `help/`). */
export interface AiSearchLike {
  search(params: {
    query: string;
    ai_search_options?: {
      retrieval?: { max_num_results?: number; match_threshold?: number; retrieval_type?: "vector" | "keyword" | "hybrid"; return_on_failure?: boolean };
      query_rewrite?: { enabled?: boolean };
      reranking?: { enabled?: boolean };
    };
  }): Promise<{ search_query?: string; chunks: AiSearchChunkLike[] }>;
}

// Analytics Engine ----------------------------------------------------------------------------------------------------

/** Ready but not declared until Nitish enables Analytics Engine on his account (design section 0 and 7.1). */
export interface AnalyticsEngineLike { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }

// Durable Object SQL (Lobby counters) -------------------------------------------------------------------------------

export type { SqlStorageLike } from "../../contracts/src/ext/cf-db";
