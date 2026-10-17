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
  // wave 2 (packages/contracts/src/wave2.ts WAVE2_ID_PREFIXES)
  "doc_", "sig_", "upl_", "obs_", "ofb_", "ofs_", "rcf_", "oen_", "eml_", "simr_", "simk_",
  // wave 3 (packages/contracts/src/wave3.ts WAVE3_ID_PREFIXES)
  "exp_", "epol_", "tot_", "top_", "tasn_", "tol_", "tor_", "hcal_", "hol_", "extl_", "dlv_", "syn_", "scr_", "spk_", "env_", "chk_", "ctf_", "simx_", "simo_",
  // wave 4 (packages/contracts/src/wave4.ts WAVE4_ID_PREFIXES)
  "cal_", "hnd_", "trc_", "tra_", "lev_", "ewn_", "csb_", "mnt_", "exi_", "rwt_", "aov_",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Prefixes whose ids may appear in event payloads (SPEC 6.5: ids only, never free text). */
export const EVENT_PAYLOAD_PREFIXES = ["offr_", "wrk_", "ntc_", "pay_", "txa_", "prp_", "rt_", "rtr_", "sima_", "simb_", "pyc_", "run_", "act_",
  "exp_", "tor_", "top_", "syn_", "scr_", "env_", "chk_",   // wave 3
  "cal_", "fil_", "upl_", "hnd_", "tra_", "lev_", "ewn_", "csb_", "mnt_", "exi_", "rwt_"] as const;   // wave 4

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
