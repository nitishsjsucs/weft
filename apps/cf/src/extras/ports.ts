// The seams between the extras and the rest of weft-core (track cf6-extras). The queue consumers and HostedExtras
// reach a world only through these CompanyDO RPC methods, and the Lobby and SpendDO only through theirs, so they never
// evaluate the Weft modules (design 3.2). cf4-worker adds the methods to the Durable Objects; the DO side of each is
// implemented in ./slot (createSlotExtras) and in @weft/cf-extras (sqlDailyCounters). Types only.
import type {
  AttachReceiptExtractArgs, AttachScanExtractArgs, CounterTake, HelpSearchResult, DictationResult, LobbyReadout, ModelComparisonRow,
  PlatformReadout, RunCatalogRow,
} from "@weft/cf-extras";
import type { HostedSpendLedger } from "../../../../packages/contracts/src/ext/cf-agent";
import type { WorldMode } from "../../../../packages/contracts/src/ext/cf-hosted";

/** What a world says about itself to a job: its generation (older jobs are dropped) and who its lease charges. */
export interface SlotWorldInfo {
  slot: string;
  gen: number;
  mode: WorldMode;
  /** The snapshot the world was restored from; the seed vectors' namespace is `seed-<snapshot>`. */
  snapshot: string;
  lease: { visitor: string | null; ipHash: string | null } | null;
}

export type WriteBackOutcome =
  | { ok: true; status: "attached" | "already" | "skipped"; reason: string | null }
  | { ok: false; code: string; message: string; retryable: boolean };

export type HiddenWriteBack =
  | { command: "expenses.attach_receipt_extract"; args: AttachReceiptExtractArgs }
  | { command: "notices.attach_scan_extract"; args: AttachScanExtractArgs };

export interface SlotExport { bytes: Uint8Array; contentType: string }

/** A world's refusal of a job from another generation than its own: never retried, the job finishes as `stale`. */
export interface StaleGenerationRefusal { ok: false; code: "STALE_GENERATION"; message: string; retryable: false }
/** What CompanyDO.extrasExport answers: the file, or the refusal of a stale job (a value, since an error thrown
 * across the RPC reaches the queue as a plain Error, which it retries). */
export type ExportOutcome = SlotExport | StaleGenerationRefusal;

/** CompanyDO's RPC methods for the extras (cf4-worker delegates each to createSlotExtras). */
export interface SlotExtrasPort {
  extrasWorld(): Promise<SlotWorldInfo>;
  /** An upload's bytes by its storage path (`blob:<sha256>`), or null. */
  extrasBlob(storagePath: string): Promise<Uint8Array | null>;
  /**
   * Runs a hidden write-back as svc_jobs inside the slot's executor. `gen` is the job's generation: CompanyDO refuses
   * one that is not the world's (STALE_GENERATION, not retryable), so a late job of the previous visitor's generation
   * never writes into the next visitor's world.
   */
  extrasWriteBack(w: HiddenWriteBack, gen: number): Promise<WriteBackOutcome>;
  /** A memory file's text at a commit, or null when the path or commit is missing. */
  extrasMemoryText(path: string, commit: string): Promise<string | null>;
  /** The world or its memory as a file; CompanyDO answers STALE_GENERATION (not retryable) for a job of another
   * generation than the world's, as it does for a write-back. */
  extrasExport(what: "memory" | "world", gen: number): Promise<ExportOutcome>;
}

/** The world's own side of the port (createSlotExtras): CompanyDO checks the generation, so its export is the file. */
export interface WorldExtrasPort extends Omit<SlotExtrasPort, "extrasExport"> {
  extrasExport(what: "memory" | "world", gen: number): Promise<SlotExport>;
}

/** LobbyDO's RPC methods for the extras. */
export interface LobbyExtrasRpc {
  extrasCounterTake(name: string, n: number, cap: number, day?: string): Promise<CounterTake>;
  extrasCounterAdd(name: string, n: number, day?: string): Promise<number>;
  extrasCounterPeek(name: string, day?: string): Promise<number>;
  extrasReadout(): Promise<LobbyReadout>;
  /** Vector ids upserted for a slot generation, deleted by id when that generation is reset (design 4.6). */
  extrasRecordVectors(slot: string, gen: number, ids: string[]): Promise<void>;
}

/** SpendDO's RPC methods the extras use. */
export type SpendExtrasRpc = Pick<HostedSpendLedger, "reserve" | "settle" | "status">;

export interface DurableNamespaceLike<T> {
  idFromName(name: string): unknown;
  get(id: unknown): T;
}

/** HostedExtras, the WorkerEntrypoint the front Worker calls over its CORE service binding. */
export interface HostedExtrasApi {
  help(query: string): Promise<HelpSearchResult>;
  dictate(input: DictateInput): Promise<DictationResult>;
  platform(): Promise<PlatformReadout>;
  models(opts?: { days?: number }): Promise<ModelComparisonRow[]>;
  recordRun(row: RunCatalogRow): Promise<void>;
  exportFile(input: { slot: string; gen: number; jobId: string; what: "memory" | "world" }): Promise<SlotExport | null>;
}
/** The front has already applied the mutation gate (lease, human grant, RL_RUN) before it calls dictate. */
export interface DictateInput { audio: Uint8Array | ArrayBuffer; contentType: string; slot: string | null; gen: number | null; visitor: string | null; ipHash: string | null }
