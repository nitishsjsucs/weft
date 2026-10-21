// The shapes CompanyDO's RPC methods take and return: the Lobby stamps generations and leases and resets slots
// through them, and ReseedWorkflow drives a full restore through them one short step at a time.
import type { WorldMode } from "../../shared/contracts";

/** What the Lobby stamps into a slot (design 4.6: the Lobby holds the authoritative generation). */
export interface WorldStamp {
  slot: string;
  gen: number;
  mode: WorldMode;
  /** The lease's visitor and daily IP hash; background runs are charged to them (design 5.3). Null when unleased. */
  visitor: string | null;
  ipHash: string | null;
}

export interface UsageDelta {
  rowsRead: number;
  rowsWritten: number;
  /** Requests and alarm invocations this object served. */
  requests: number;
}
export const zeroUsage = (): UsageDelta => ({ rowsRead: 0, rowsWritten: 0, requests: 0 });

export interface SlotHeartbeat {
  stamped: WorldStamp | null;
  /** Wall-clock ms of the last request from the lease's visitor, kept in memory only (design 6.2). */
  lastActivityMs: number | null;
  /** No domain row was written since the last reset (the dirty-key table is empty). */
  clean: boolean;
  /** Usage since the previous heartbeat or usage push. */
  usage: UsageDelta;
  /** The snapshot this world was restored from. */
  snapshot: string | null;
}

export interface ResetOutcome {
  ok: boolean;
  method: "delta" | "pitr" | "stamp";
  gen: number;
  rowsWritten: number;
  /** Tables whose digest did not match the manifest (a full restore follows). */
  mismatches: string[];
  ms: number;
}

export type RestoreMode = WorldMode;
export interface RestoreBeginInput { slot: string; gen: number; mode: RestoreMode }
export interface RestoreVerify { ok: boolean; mismatches: string[]; chainValid: boolean; rows: number }
export interface RestoreFinish { slot: string; gen: number; snapshot: string; bookmark: string | null; rowsWritten: number }
