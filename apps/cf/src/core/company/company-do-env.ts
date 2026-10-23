// The env a hosted world reads (design 3.3, 5.2 and 6.3): Worker vars and secrets with the KV weft-config values
// folded in under the names the Weft stack reads, as a live read-only view, so a KV change reaches the world within
// the 60 s config memo without a reboot. Pure, so the unit suite pins it.
import { optIn } from "@weft/cf-extras";
import { HOSTED_CONFIG_KEYS, type WorldMode } from "../../shared/contracts";

/** KV weft-config values folded into the world's env under the names the Weft stack reads (at most 60 s old). */
export function configEnv(values: Map<string, string | null>, mode: WorldMode): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string | null | undefined) => { if (v !== null && v !== undefined && v.trim() !== "") out[k] = v.trim(); };
  set("WEFT_AGENT_ENABLED", values.get(HOSTED_CONFIG_KEYS.agentEnabled));
  set("WEFT_HOSTED_PROVIDER", values.get(HOSTED_CONFIG_KEYS.modelProvider));
  const recall = values.get(HOSTED_CONFIG_KEYS.recallSemantic);
  // The same accepted values as the extras' own flag reader (on, true, 1, yes), so the world and the extras agree.
  if (recall) out.WEFT_SEMANTIC_RECALL = optIn(recall) ? "1" : "0";
  set("WEFT_AIG_COLLECT_LOG", values.get(HOSTED_CONFIG_KEYS.aigCollectLog));
  set("WEFT_RUN_USD_CAP", values.get(HOSTED_CONFIG_KEYS.capRunUsd));
  set("WEFT_DAY_USD_CAP", values.get(HOSTED_CONFIG_KEYS.capDayUsd));
  set("WEFT_LIVE_USD_CAP", values.get(HOSTED_CONFIG_KEYS.capLiveUsd));
  set("WEFT_VISITOR_DAY_USD_CAP", values.get(HOSTED_CONFIG_KEYS.capVisitorDayUsd));
  set("WEFT_IP_DAY_USD_CAP", values.get(HOSTED_CONFIG_KEYS.capIpDayUsd));
  set("WEFT_NEURON_DAY_CAP", values.get(HOSTED_CONFIG_KEYS.capNeuronsDay));
  for (const [k, name] of [["extrasOcr", "WEFT_EXTRAS_OCR"], ["extrasPdf", "WEFT_EXTRAS_PDF"], ["extrasHelp", "WEFT_EXTRAS_HELP"], ["extrasDictation", "WEFT_EXTRAS_DICTATION"]] as const) {
    set(name, values.get(HOSTED_CONFIG_KEYS[k]));
  }
  // slot-smoke spends $0: the provider is forced to scripted (design 6.1).
  if (mode === "smoke") { out.WEFT_LLM = "scripted"; out.WEFT_HOSTED_PROVIDER = "scripted"; }
  return out;
}

/** A live, read-only view of `base` with `overrides()` on top: the Weft stack reads the current value at each use. */
export function liveEnv(base: Record<string, string>, overrides: () => Record<string, string>): Readonly<Record<string, string | undefined>> {
  const merged = () => ({ ...base, ...overrides() });
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_t, k) => (typeof k === "string" ? merged()[k] : undefined),
    has: (_t, k) => typeof k === "string" && k in merged(),
    ownKeys: () => Object.keys(merged()),
    getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && k in merged() ? { value: merged()[k], enumerable: true, configurable: true, writable: false } : undefined),
    set: () => false,
    deleteProperty: () => false,
  });
}
