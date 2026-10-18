// Pure numeric grounding (harness 4.8), ported from StaySignal src/shared/grounding/* (MIT, same author).
// Frozen signature: every number in `text` must appear in some tool result (with the cents rule); an optional third
// argument adds the request, the run clock and the run's own echoed arguments.
// runEvidence builds both of those arguments from one run's step rows: the loop's guard and the eval suite's G5 call
// it, so the two grade an answer with the same evidence (round 1 analysis R1).
// Decision (round 2, FG4): only the person's request may derive a window bound from a relative phrase ("next week",
// "the next two weeks"); the same phrase in the answer derives nothing, and today is always known from the clock.
// Pinned in test/windows.test.ts; check.ts explains why.
// computedFigures (after the wave 4 model comparison) keeps only the structured figures of a routine's precheck, so the
// message guard can ground what the routine itself computed while every figure with no source is still refused.
export { check, isIdentifier, type CheckOptions, type GroundingResult } from "./check";
export { extractNumerals, collectLeaves, TAINTED_LEAF, type LeafOptions, type Numeral, type Leaves } from "./numerals";
export { clockDates, datesIn, parseTextDate, readTextDates, type DateKey } from "./dates";
export { runEvidence, requestTrustOf, unescapeTagText, MODEL_AUTHORED_TOOLS, type EvidenceStep, type RunEvidence, type RunEvidenceOptions } from "./evidence";
export { computedFigures } from "./computed";
export { PLACEHOLDER, renderPlaceholders, resolvePath, usd, type AliasEntry, type AliasMap, type RenderResult } from "./aliases";
