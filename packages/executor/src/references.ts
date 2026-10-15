// Hallucinated ids (harness 4.6): id-shaped fields must exist in the run's company; otherwise UNKNOWN_REFERENCE
// with up to 3 closest ids, searched only in ctx.companyId and only in domains the effective grant can view.
import { sql } from "drizzle-orm";
import { ID_SHAPE, idPrefixOf, type Domain, type IdPrefix } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import { GRANT_RANK, type Grants } from "./store";

interface RefTable { domain: Domain; from: string; idCol: string; company: string }
const T = (domain: Domain, from: string, idCol: string, company: string): RefTable => ({ domain, from, idCol, company });

/** Prefix -> where the id lives and how it belongs to a company. Only these prefixes are checked. */
export const REF_TABLES: Partial<Record<IdPrefix, RefTable>> = {
  "wrk_": T("people", "workers x", "x.id", "x.company_id"),
  "prt_": T("people", "pay_rates x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "bnk_": T("people", "bank_accounts x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "obt_": T("people", "onboarding_tasks x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "offr_": T("people", "offers x", "x.id", "x.company_id"),
  "wkp_": T("company", "workplaces x", "x.id", "x.company_id"),
  "dpt_": T("company", "departments x", "x.id", "x.company_id"),
  "pay_": T("payroll", "payroll_runs x", "x.id", "x.company_id"),
  "pyc_": T("payroll", "paychecks x JOIN payroll_runs r ON r.id = x.payroll_run_id", "x.id", "r.company_id"),
  "ps_": T("payroll", "pay_schedules x", "x.id", "x.company_id"),
  "ntc_": T("tax", "notices x", "x.id", "x.company_id"),
  "txa_": T("tax", "tax_accounts x", "x.id", "x.company_id"),
  "etr_": T("tax", "employer_tax_rates x", "x.id", "x.company_id"),
  "bpl_": T("benefits", "benefit_plans x", "x.id", "x.company_id"),
  "ben_": T("benefits", "benefit_enrollments x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "ita_": T("it", "it_accounts x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "dev_": T("it", "devices x JOIN workers w ON w.id = x.worker_id", "x.id", "w.company_id"),
  "prp_": T("company", "proposals x", "x.id", "x.company_id"),
  "rt_": T("company", "routines x", "x.id", "x.company_id"),
  "rtr_": T("company", "routine_runs x JOIN routines r ON r.id = x.routine_id", "x.id", "r.company_id"),
  "run_": T("company", "exec_runs x", "x.id", "x.company_id"),
  "art_": T("company", "run_artifacts x JOIN exec_runs r ON r.id = x.run_id", "x.id", "r.company_id"),
};

/** Collects id-shaped string values (whole-string matches only) with a checked prefix. */
export function idShapedValues(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "string") {
    const p = idPrefixOf(v);
    if (p && REF_TABLES[p] && ID_SHAPE.test(v)) out.add(v);
  } else if (Array.isArray(v)) for (const x of v) idShapedValues(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) idShapedValues(x, out);
  return out;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export interface UnknownRef { id: string; closest: string[] }

export async function findUnknownReference(db: DbTx, companyId: string, input: unknown, grants: Grants): Promise<UnknownRef | null> {
  for (const id of idShapedValues(input)) {
    const t = REF_TABLES[idPrefixOf(id)!]!;
    const visible = GRANT_RANK[grants[t.domain]] >= GRANT_RANK.view;
    const rows = visible
      ? await db.all<{ id: string }>(sql.raw(`SELECT ${t.idCol} AS id FROM ${t.from} WHERE ${t.idCol} = '${id.replace(/'/g, "''")}' AND ${t.company} = '${companyId.replace(/'/g, "''")}' LIMIT 1`))
      : [];
    if (rows.length > 0) continue;
    let closest: string[] = [];
    if (visible) {
      const prefix = idPrefixOf(id)!;
      const all = await db.all<{ id: string }>(sql.raw(`SELECT ${t.idCol} AS id FROM ${t.from} WHERE ${t.company} = '${companyId.replace(/'/g, "''")}' AND ${t.idCol} LIKE '${prefix}%' LIMIT 2000`));
      closest = all.map((r) => r.id).sort((a, b) => distance(id, a) - distance(id, b) || (a < b ? -1 : 1)).slice(0, 3);
    }
    return { id, closest };
  }
  return null;
}
