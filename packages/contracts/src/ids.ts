// Id prefixes (SPEC 6). Counter ids are `${prefix}${n padded to 4}` from the id_counters table;
// named seed ids (cmp_larkspur, wkp_oakland, pay_2026_10_30, rt_agency_notice) use the same prefixes.
export const ID_PREFIXES = [
  "cmp_", "wkp_", "dpt_", "wrk_", "prt_", "ps_", "tim_", "bnk_", "offr_", "obt_",
  "usr_", "agt_", "svc_", "key_",
  "pay_", "pyc_",
  "txa_", "etr_", "ntc_", "fil_",
  "bpl_", "ben_", "ita_", "dev_", "cpy_",
  "run_", "art_", "act_", "prp_", "rt_", "rtr_", "evt_", "res_", "thr_", "rsv_", "dec_",
  "sima_", "simm_", "simb_", "simi_", "simd_", "simc_", "simv_", "simf_",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Prefixes whose ids may appear in event payloads (SPEC 6.5: ids only, never free text). */
export const EVENT_PAYLOAD_PREFIXES = ["offr_", "wrk_", "ntc_", "pay_", "txa_", "prp_", "rt_", "rtr_", "sima_", "simb_", "pyc_", "run_", "act_"] as const;

export function formatId(prefix: IdPrefix, n: number): string {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

/** Longest prefix first so "sima_" wins over "sim" style collisions and "offr_" is never read as "of". */
export function idPrefixOf(id: string): IdPrefix | null {
  let best: IdPrefix | null = null;
  for (const p of ID_PREFIXES) if (id.startsWith(p) && (!best || p.length > best.length)) best = p;
  return best;
}

export const ID_SHAPE = /^[a-z]{2,5}_[A-Za-z0-9_]+$/;
