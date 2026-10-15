// Pure numeric grounding (harness 4.8), to be ported from StaySignal src/shared/grounding/* by t4-agent.
// Frozen signature: every number in `text` must appear in some tool result (with the cents rule).
export interface GroundingResult { ok: boolean; offending: string[] }

export function check(_text: string, _toolResults: unknown[]): GroundingResult {
  return { ok: true, offending: [] };
}
