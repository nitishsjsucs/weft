// The scripted provider's variant chooser for rt_compliance_notices (harness 11.5). Owner: w4-parity-compliance.
// The scripted provider stands in for a model and cannot branch, so each handling plan has its own script
// (scenarios/rt_compliance_notices.<plan>.json). This picks the script with the same planNotice() the precheck uses,
// from the stored notice and filing rows. A live model reads the derived plan instead and never sees this hook.
// Wiring it into apps/api/src/compose.ts scriptVariant is a contract request (docs/tracks/w4-parity-compliance.md).
import { and, eq } from "drizzle-orm";
import { filings, notices, type DbTx } from "@weft/db";
import { NOTICE_FORM_CODES, noticeScriptName, planNotice, RT_COMPLIANCE_NOTICES } from "../../../contracts/src/ext/w4-parity-compliance";
import { parseExtract } from "../notices/queries";

export function complianceNoticeVariant(db: DbTx) {
  return async ({ routineId, trigger }: { routineId: string; trigger: Record<string, unknown> }): Promise<string | null> => {
    if (routineId !== RT_COMPLIANCE_NOTICES || typeof trigger.notice_id !== "string") return null;
    const [n] = await db.select().from(notices).where(eq(notices.id, trigger.notice_id)).limit(1);
    if (!n) return null;
    const ex = parseExtract(n.extractedJson as string | null);
    const form = ex ? NOTICE_FORM_CODES[ex.formCode] ?? null : null;
    const [f] = form && ex?.period && n.taxAccountId
      ? await db.select().from(filings).where(and(eq(filings.form, form), eq(filings.period, ex.period))).limit(1)
      : [];
    const { plan } = planNotice({ kind: n.kind, extract: ex, taxAccountId: n.taxAccountId, filing: f ? { id: f.id, status: f.status } : null });
    return plan === "update_rate" ? null : noticeScriptName(plan);
  };
}
