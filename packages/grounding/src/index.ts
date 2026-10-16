// Pure numeric grounding (harness 4.8), ported from StaySignal src/shared/grounding/* (MIT, same author).
// Frozen signature: every number in `text` must appear in some tool result (with the cents rule).
export { check, isIdentifier, type GroundingResult } from "./check";
export { extractNumerals, collectLeaves, type Numeral, type Leaves } from "./numerals";
export { PLACEHOLDER, renderPlaceholders, resolvePath, usd, type AliasEntry, type AliasMap, type RenderResult } from "./aliases";
