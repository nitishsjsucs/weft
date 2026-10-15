// t3-governance additive contract (AGENTS.md rule 7). Additive only; the integrator folds it into commands.ts.
import type { AgentCall, RunHandle } from "../commands";

/**
 * The loop sets `batch` to the model step that emitted the call (one model turn = one batch), so the executor can
 * apply the batch rules of harness 4.6 (SKIPPED_AFTER_BLOCK, afterPending). Without it the executor falls back to
 * the run's latest run_steps row of kind model_call, and with no such row the whole run counts as one batch.
 */
export type BatchedAgentCall = AgentCall & { batch?: string | number | null };

/**
 * Handles minted by RunAuthority also carry the run nonce (16 hex, harness 6.3). The loop puts it in input[1] and in
 * every harness tag it renders (<weft_notice n="...">); the executor wraps untrusted fields with the same nonce.
 */
export interface RunHandleWithNonce extends RunHandle { readonly nonce: string }

/**
 * Optional fields a command's CommandOutput may carry for the executor (read by the pipeline, never by the model):
 * `taintedBy` taints the run with that source, `untrusted` adds dotted paths to wrap for this result only.
 */
export interface CommandOutputTaintHints { taintedBy?: string | null; untrusted?: string[] }
