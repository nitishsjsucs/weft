// Copied verbatim from research/harness.md section 13 (spend.ts).
export interface SpendEntry { at: string; runId: string | null; kind: "reserve" | "settle" | "release"; reservationId: string; usdMicros: number; model: string; live: boolean }
export interface SpendLedger {                    // .data/spend/<yyyy-mm-dd UTC>.jsonl, mkdir lock, never reset
  reserve(input: { runId: string | null; usdMicros: number; model: string; live: boolean }):
    Promise<{ ok: true; reservationId: string } | { ok: false; code: "BUDGET_EXCEEDED"; cap: "run" | "day" | "live"; spentMicros: number }>;
  settle(reservationId: string, actualUsdMicros: number): Promise<void>;
  release(reservationId: string): Promise<void>;
  spent(scope: { day?: string; runId?: string; live?: boolean }): Promise<number>;
}
