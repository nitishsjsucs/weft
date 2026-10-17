// The scripted provider's variant chooser for rt_compliance_notices (harness 11.5). Owner: w4-parity-compliance.
// The scripted provider stands in for a model and cannot branch, so each handling plan has its own script
// (scenarios/rt_compliance_notices.<plan>.json). This picks the script with the same planNotice() the precheck uses,
// from the stored notice and filing rows. A live model reads the derived plan instead and never sees this hook.
// Wiring it into apps/api/src/compose.ts scriptVariant is a contract request (docs/tracks/w4-parity-compliance.md).
import { and, eq } from "drizzle-orm";
import { filings, notices, type DbTx } from "@weft/db";
import { NOTICE_FORM_CODES, noticeScriptName, planNotice, RT_COMPLIANCE_NOTICES, RT_COMPLIANCE_UPLOADS, uploadScriptName } from "../../../contracts/src/ext/w4-parity-compliance";
import { addDays, listAssignments, missingAssignments } from "./training";
import { ptDateOf } from "../demo/define";
import { parseExtract } from "../notices/queries";

/** `now` is the sim clock (the training variant needs today's date in PT). */
export function complianceNoticeVariant(db: DbTx, now: () => string = () => new Date().toISOString()) {
  return async ({ routineId, trigger }: { routineId: string; trigger: Record<string, unknown> }): Promise<string | null> => {
    if (routineId === "rt_compliance_training") return trainingVariant(db, ptDateOf(now()));
    const upload = routineId === RT_COMPLIANCE_UPLOADS;
    if ((routineId !== RT_COMPLIANCE_NOTICES && !upload) || typeof trigger.notice_id !== "string") return null;
    const [n] = await db.select().from(notices).where(eq(notices.id, trigger.notice_id)).limit(1);
    if (!n) return null;
    const ex = parseExtract(n.extractedJson as string | null);
    const form = ex ? NOTICE_FORM_CODES[ex.formCode] ?? null : null;
    const [f] = form && ex?.period && n.taxAccountId
      ? await db.select().from(filings).where(and(eq(filings.form, form), eq(filings.period, ex.period))).limit(1)
      : [];
    const confidence = (() => { try { const v = JSON.parse((n.extractedJson as string | null) ?? "null") as { confidence?: unknown } | null; return typeof v?.confidence === "number" ? v.confidence : null; } catch { return null; } })();
    const { plan } = planNotice({ kind: n.kind, extract: ex ? { ...ex, confidence } : null, taxAccountId: n.taxAccountId, filing: f ? { id: f.id, status: f.status } : null, source: upload ? "upload" : "simulated" });
    if (upload) return uploadScriptName(plan);
    return plan === "update_rate" ? null : noticeScriptName(plan);
  };
}

/** rt_compliance_training.<assign|remind|both>, from the same rows the precheck reads. */
async function trainingVariant(db: DbTx, today: string): Promise<string | null> {
  const missing = await missingAssignments(db, "cmp_larkspur", today);
  const weekAgo = addDays(today, -7);
  const remind = (await listAssignments(db, "cmp_larkspur", today)).filter((a) => ["assigned", "reminded", "overdue"].includes(a.status) && a.daysLeft <= 14 && (!a.remindedAt || a.remindedAt.slice(0, 10) <= weekAgo));
  const plan = missing.length && remind.length ? "both" : missing.length ? "assign" : remind.length ? "remind" : null;
  return plan ? `rt_compliance_training.${plan}` : null;
}
