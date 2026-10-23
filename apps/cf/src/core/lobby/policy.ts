// The Lobby's pure rules (design 6.2, 6.5, 8.2 and 9.2, with the section 0 settings): Weft's daily shares of the
// account caps, the degradation level, the rows-written budget that admits leases and full restores, and lease
// expiry. No I/O, so the unit suite pins every threshold.
import { HOSTED_DELTA_RESET_BASELINE_ROWS, HOSTED_SETTINGS, type DegradationLevel } from "../../shared/contracts";

/** Weft's daily shares of the account-wide caps (design 8.2: 60% of requests, rows and duration). */
export const SHARES = {
  doRowsWritten: 60_000,
  doRowsRead: 3_000_000,
  doRequests: 60_000,
  workersRequests: 60_000,
} as const;
export type ShareKey = keyof typeof SHARES;

/**
 * Rows written on a day that starts full restores. Section 0 seeds the whole pool on the first UTC day: the showcase,
 * slot-smoke and two pool slots are 4 x 20,556 = 82,224 rows written, above design 9.2's 80,000, so the provisioning
 * ceiling is 90,000. The other apps peaked at 6,672 rows written a day, which leaves 3,104 rows of margin under the
 * account's 100,000 (KV lobby.provision_rows_ceiling changes it).
 */
export const PROVISION_ROWS_CEILING = 90_000;
/** Rows written by one full restore of the rich world (verified locally; KV lobby.full_restore_rows changes it). */
export const FULL_RESTORE_ROWS = 20_556;
/** Rows written by an engaged session's own activity with dirty tracking (verified locally, design 2). */
export const SESSION_ACTIVITY_ROWS = 894;
/** About what the Lobby and the spend ledger write for one session. */
export const SESSION_OVERHEAD_ROWS = 100;
/** Rows written by one engaged session: its activity, the delta reset after it on the SQL memory repo hosted worlds
 * run (cf1's measured baseline, HOSTED_DELTA_RESET_BASELINE_ROWS), and the Lobby and ledger rows: 1,711. */
export const SESSION_ROWS_ESTIMATE = SESSION_ACTIVITY_ROWS + HOSTED_DELTA_RESET_BASELINE_ROWS + SESSION_OVERHEAD_ROWS;

export interface DayUsage {
  /** Rows written by worlds outside full restores: visitor activity, resets, ledger and Lobby rows. */
  visitorRowsWritten: number;
  /** Rows written by full restores: the estimate when one starts, corrected to the measured count when it ends. */
  restoreRows: number;
  restores: number;
  doRowsRead: number;
  doRequests: number;
  workersRequests: number;
}
export const emptyUsage = (): DayUsage => ({ visitorRowsWritten: 0, restoreRows: 0, restores: 0, doRowsRead: 0, doRequests: 0, workersRequests: 0 });

export interface BudgetConfig {
  rowsWrittenShare: number;
  provisionRowsCeiling: number;
  fullRestoreRows: number;
}
export const defaultBudget = (): BudgetConfig => ({ rowsWrittenShare: SHARES.doRowsWritten, provisionRowsCeiling: PROVISION_ROWS_CEILING, fullRestoreRows: FULL_RESTORE_ROWS });

const provisionCeiling = (b: BudgetConfig) => Math.max(b.rowsWrittenShare, b.provisionRowsCeiling);
export const totalRowsWritten = (u: DayUsage): number => u.visitorRowsWritten + u.restoreRows;

/** Today's rows-written ceiling: the share, raised to the provisioning ceiling on a day that started a full restore. */
export function rowsCeiling(u: DayUsage, b: BudgetConfig): number {
  return u.restores > 0 ? provisionCeiling(b) : b.rowsWrittenShare;
}

/** What visitors may write today: the ceiling less the restores, and never more than the normal share. */
export function visitorRowsBudget(u: DayUsage, b: BudgetConfig): number {
  return Math.max(0, Math.min(b.rowsWrittenShare, rowsCeiling(u, b) - u.restoreRows));
}

/** A full restore fits today when everything written stays under the provisioning ceiling. */
export function restoreFits(u: DayUsage, b: BudgetConfig): boolean {
  return totalRowsWritten(u) + b.fullRestoreRows <= provisionCeiling(b);
}

/** Full restores left today under the provisioning ceiling. */
export function restoresLeft(u: DayUsage, b: BudgetConfig): number {
  return Math.max(0, Math.floor((provisionCeiling(b) - totalRowsWritten(u)) / Math.max(1, b.fullRestoreRows)));
}

/** A new lease fits when one more engaged session stays inside the visitors' rows budget. */
export function sessionFits(u: DayUsage, b: BudgetConfig): boolean {
  return u.visitorRowsWritten + SESSION_ROWS_ESTIMATE <= visitorRowsBudget(u, b);
}

/** Each share against its use (rows written against the visitors' budget, so planned restores do not close the day). */
export function shareUse(u: DayUsage, b: BudgetConfig): Record<ShareKey, { used: number; share: number }> {
  return {
    doRowsWritten: { used: u.visitorRowsWritten, share: visitorRowsBudget(u, b) },
    doRowsRead: { used: u.doRowsRead, share: SHARES.doRowsRead },
    doRequests: { used: u.doRequests, share: SHARES.doRequests },
    workersRequests: { used: u.workersRequests, share: SHARES.workersRequests },
  };
}

export interface LevelInput {
  usage: DayUsage;
  budget: BudgetConfig;
  /** The day dollar cap or the neuron cap is spent. */
  dollarsOrNeuronsSpent: boolean;
  /** KV agent.enabled=false. */
  agentPaused: boolean;
  floor: DegradationLevel;
}

export interface LevelResult { level: DegradationLevel; reasons: string[] }

/** The degradation ladder (design 6.5). */
export function degradationLevel(i: LevelInput): LevelResult {
  const s = shareUse(i.usage, i.budget);
  const frac = (k: ShareKey) => (s[k].share > 0 ? s[k].used / s[k].share : 1);
  const reasons: string[] = [];
  let level: DegradationLevel = 0;
  const at70 = (Object.keys(s) as ShareKey[]).filter((k) => frac(k) >= 0.7);
  if (at70.length) { level = 1; reasons.push(...at70.map((k) => `${k}>=70%`)); }
  if (i.dollarsOrNeuronsSpent) { level = 2; reasons.push("budget"); }
  if (i.agentPaused) { level = 2; reasons.push("paused"); }
  const at90 = (["doRowsWritten", "doRowsRead", "doRequests"] as const).filter((k) => frac(k) >= 0.9);
  if (at90.length) { level = 3; reasons.push(...at90.map((k) => `${k}>=90%`)); }
  if (i.floor > level) { level = i.floor; reasons.push(`floor ${i.floor}`); }
  return { level, reasons };
}

export interface LeaseTimes { startedAt: number; lastSeen: number }
export const leaseExpiresAt = (l: LeaseTimes): number => l.startedAt + HOSTED_SETTINGS.leaseTotalMinutes * 60_000;
export const leaseIdleExpiresAt = (l: LeaseTimes): number => Math.min(leaseExpiresAt(l), l.lastSeen + HOSTED_SETTINGS.leaseIdleMinutes * 60_000);
export function leaseEnded(l: LeaseTimes, now: number): "total" | "idle" | null {
  if (now >= leaseExpiresAt(l)) return "total";
  if (now >= l.lastSeen + HOSTED_SETTINGS.leaseIdleMinutes * 60_000) return "idle";
  return null;
}
/** Minutes until the soonest lease can end (its total or idle expiry), for the waitlist screen. */
export function etaMinutes(leases: readonly LeaseTimes[], now: number): number | null {
  if (!leases.length) return null;
  const soonest = Math.min(...leases.map((l) => leaseIdleExpiresAt(l)));
  return Math.max(1, Math.ceil((soonest - now) / 60_000));
}

/** Waitlist entries not refreshed for this long are dropped. */
export const WAITLIST_TTL_MS = 10 * 60_000;
