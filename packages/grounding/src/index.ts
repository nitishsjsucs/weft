// Pure numeric grounding (harness 4.8), ported from StaySignal src/shared/grounding/* (MIT, same author).
// Frozen signature: every number in `text` must appear in some tool result (with the cents rule); an optional third
// argument adds the request, the run clock and the run's own echoed arguments.
// Decision (round 2, FG4): only the person's request may derive a window bound from a relative phrase ("next week",
// "the next two weeks"); the same phrase in the answer derives nothing, and today is always known from the clock.
// Pinned in test/windows.test.ts; check.ts explains why.
export { check, isIdentifier, type CheckOptions, type GroundingResult } from "./check";
export { extractNumerals, collectLeaves, TAINTED_LEAF, type LeafOptions, type Numeral, type Leaves } from "./numerals";
export { clockDates, datesIn, parseTextDate, readTextDates, type DateKey } from "./dates";
export { PLACEHOLDER, renderPlaceholders, resolvePath, usd, type AliasEntry, type AliasMap, type RenderResult } from "./aliases";
