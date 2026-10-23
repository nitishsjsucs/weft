// The extras flags (design 6.3 and 7.1), read from KV `weft-config` and memoized in the isolate for
// HOSTED_SETTINGS.configMemoMs. Each extra is a kill flag: absent means on, "off" (or "false") turns it off, so an
// operator can stop OCR, PDF rendering, Help or dictation without a redeploy. Semantic recall is the exception: it
// stays off until the live L1 to L4 gate passes. KV recall.semantic decides when it is set ("on" or "off"), so the
// deploy track turns it on without a redeploy; while it is absent, the WEFT_SEMANTIC_RECALL var decides (hosted "0").
// Track cf6-extras.
import { HOSTED_CONFIG_KEYS, HOSTED_SETTINGS } from "../../contracts/src/ext/cf-hosted";
import type { KvLike } from "./bindings";

export interface ExtrasFlags { ocr: boolean; pdf: boolean; help: boolean; dictation: boolean; recallSemantic: boolean }
export const EXTRAS_FLAGS_ALL_OFF: ExtrasFlags = { ocr: false, pdf: false, help: false, dictation: false, recallSemantic: false };

const OFF = new Set(["off", "false", "0", "no"]);
/** The values that turn an opt-in flag on (recall.semantic, WEFT_SEMANTIC_RECALL), trimmed and lowercased. The one
 * set: CompanyDO folds KV recall.semantic into the world's env with it too (apps/cf company-do-env.ts). */
export const FLAG_ON_VALUES: ReadonlySet<string> = new Set(["on", "true", "1", "yes"]);
const killFlag = (v: string | null) => v === null || !OFF.has(v.trim().toLowerCase());
/** True when an opt-in flag's value is one of FLAG_ON_VALUES. */
export const optIn = (v: string | null | undefined): boolean => v !== null && v !== undefined && FLAG_ON_VALUES.has(v.trim().toLowerCase());

/** Pure: the flags from the raw KV values and the Worker env. */
export function flagsFrom(values: Partial<Record<keyof typeof HOSTED_CONFIG_KEYS, string | null>>, env: { WEFT_SEMANTIC_RECALL?: string | undefined } = {}): ExtrasFlags {
  return {
    ocr: killFlag(values.extrasOcr ?? null),
    pdf: killFlag(values.extrasPdf ?? null),
    help: killFlag(values.extrasHelp ?? null),
    dictation: killFlag(values.extrasDictation ?? null),
    recallSemantic: values.recallSemantic !== null && values.recallSemantic !== undefined ? optIn(values.recallSemantic) : optIn(env.WEFT_SEMANTIC_RECALL),
  };
}

const KEYS = ["extrasOcr", "extrasPdf", "extrasHelp", "extrasDictation", "recallSemantic"] as const;

/**
 * A memoized reader. Each read of the five keys is one KV read per key per memo window (KV allows 100,000 reads a
 * day). A KV failure keeps the last known flags, or all off when there are none, so an outage never turns an extra on.
 */
export function createFlagReader(kv: KvLike | null | undefined, env: { WEFT_SEMANTIC_RECALL?: string | undefined } = {}, opts: { memoMs?: number; now?: () => number } = {}): () => Promise<ExtrasFlags> {
  const memoMs = opts.memoMs ?? HOSTED_SETTINGS.configMemoMs;
  const now = opts.now ?? Date.now;
  let cached: { at: number; flags: ExtrasFlags } | null = null;
  return async () => {
    if (!kv) return { ...EXTRAS_FLAGS_ALL_OFF };
    if (cached && now() - cached.at < memoMs) return cached.flags;
    try {
      const values = Object.fromEntries(await Promise.all(KEYS.map(async (k) => [k, await kv.get(HOSTED_CONFIG_KEYS[k])] as const)));
      cached = { at: now(), flags: flagsFrom(values, env) };
    } catch {
      cached = { at: now(), flags: cached?.flags ?? { ...EXTRAS_FLAGS_ALL_OFF } };
    }
    return cached.flags;
  };
}
