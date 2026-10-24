// notices.* writes: draft a response from a template plus a short note (R1), send the latest draft to the agency
// simulator (R3, always; not reversible) and resolve the notice on confirmation.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { notices, taxAccounts, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, notFound, rateDisplay, riskOf, writeCommand } from "../demo/define";
import { AGENCY_LABELS } from "../tax/queries";
import { getNotice, parseDrafts, parseExtract, type NoticeDraft, type NoticeRow } from "./queries";

export const MAX_NOTE_CHARS = 400;
export const NOT_REVERSIBLE_REASONS: Readonly<Record<string, string>> = {
  "notices.send_response": "Not reversible: filed with the agency",
  "tax.register_state_account": "Not reversible: filed with the agency",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** A calendar date as a letter writes it: "2026-10-26" (or an instant on that day) is "October 26, 2026". */
export function letterDate(isoOrDate: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoOrDate ?? "");
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}

/**
 * Deterministic response body per notice kind, built only from structured fields. It is the text filed with the
 * agency, so it names the notice by its form and the day it arrived, never by Weft's row id, and writes dates as a
 * letter does.
 */
export function responseTemplate(n: NoticeRow, accountNumber: string | null): string {
  const ex = parseExtract(n.extractedJson);
  const label = AGENCY_LABELS[n.agency] ?? n.agency;
  const head = `To: ${label}\nRe: ${n.formCode} notice received ${letterDate(n.receivedAt) ?? n.receivedAt}, employer account ${accountNumber ?? ex?.accountNumber ?? "on file"}\nFrom: Larkspur Robotics, Inc., payroll@larkspur.example\n\n`;
  const by = letterDate(n.respondBy) ?? "the respond-by date";
  if (n.kind === "rate_change" && ex && ex.rates.length) {
    const lines = ex.rates.map((r) => `${r.code.toUpperCase()} ${rateDisplay(r.newRate)}${r.oldRate ? ` replacing ${rateDisplay(r.oldRate)}` : ""}`).join("; ");
    return `${head}We acknowledge the revised ${ex.taxYear ?? ""} contribution rates (${lines}) effective ${letterDate(ex.effectiveFrom) ?? "as stated"} and will apply them in payroll from that date. Please credit any contributions paid above the revised rate to our account.`.replace("revised  contribution", "revised contribution");
  }
  if (n.kind === "missing_filing") return `${head}We are reviewing the ${ex?.period ?? ""} filing named in this notice and will file or confirm the return on file by ${by}.`;
  return `${head}We acknowledge this notice and will respond by ${by}.`;
}

async function loadNotice(tx: DbTx, companyId: string, id: string) {
  const n = await getNotice(tx, companyId, id);
  if (!n) throw notFound("notice", id);
  const [acct] = n.taxAccountId ? await tx.select().from(taxAccounts).where(eq(taxAccounts.id, n.taxAccountId)).limit(1) : [];
  return { n, acct: acct ?? null };
}

const DraftInput = z.object({ notice_id: z.string(), note: z.string().max(MAX_NOTE_CHARS).optional() });
export const draftResponse = writeCommand({
  name: "notices.draft_response", summary: "Draft a reply to an agency notice from the template.",
  description: "Draft a reply to an agency notice. The body is Weft's template for the notice kind, built from the parsed fields, and already acknowledges its figures. You supply only note: one optional closing sentence to the agency (plain text, up to 400 characters), filed as written, never asking the agency to confirm its own figures. Saves a numbered draft. R1: no approval; sending is notices.send_response.",
  input: DraftInput, domain: "tax", needs: "edit", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "executable", task: "executable" }, preview: null,
  async run(i, ctx, deps) {
    const { n, acct } = await loadNotice(deps.tx, ctx.companyId, i.notice_id);
    if (n.status === "resolved") throw new DomainRefusal("DOMAIN_NOTICE_RESOLVED", `${n.id} is already resolved`, null, null);
    const note = (i.note ?? "").replace(/[<>]/g, "").trim();
    // The note is the letter's closing sentence to the agency, so it carries no label.
    const body = responseTemplate(n, acct?.accountNumber ?? null) + (note ? `\n\n${note}` : "");
    const drafts = parseDrafts(n.draftsJson);
    const draft: NoticeDraft = { n: drafts.length + 1, created_at: ctx.now, body, note, tainted_by: ctx.tainted ? `run:${ctx.run?.id ?? "unknown"}` : null };
    await deps.tx.update(notices).set({ draftsJson: JSON.stringify([...drafts, draft]), status: n.status === "new" ? "in_review" : n.status }).where(eq(notices.id, n.id));
    return { data: { notice_id: n.id, draft_n: draft.n, body, chars: body.length }, summary: `Drafted response ${draft.n} for ${n.id}` };
  },
});

const SendInput = z.object({ notice_id: z.string() });
type SendInput = z.infer<typeof SendInput>;
async function latestDraft(i: SendInput, companyId: string, tx: DbTx) {
  const { n, acct } = await loadNotice(tx, companyId, i.notice_id);
  if (n.status === "resolved") throw new DomainRefusal("DOMAIN_NOTICE_RESOLVED", `${n.id} is already resolved`, null, null);
  const d = parseDrafts(n.draftsJson).at(-1);
  if (!d) throw new DomainRefusal("DOMAIN_NO_DRAFT", `${n.id} has no draft response`, "Call notices.draft_response first", { notice_id: n.id, note: "" });
  return { n, acct, d };
}
export const sendResponse = writeCommand({
  name: "notices.send_response", summary: "File the latest draft reply with the agency simulator.",
  description: "Propose filing the latest draft reply to an agency notice with that agency's simulator. R3: always needs approval, and it is not reversible (filed with the agency). On confirmation Weft stores the agency's confirmation and marks the notice resolved.",
  input: SendInput, domain: "tax", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", reversible: false,
  untrustedFields: ["confirmation"], lease: (i) => `notice:${i.notice_id}`,
  async preview(i, ctx, deps) {
    const { n, d } = await latestDraft(i, ctx.companyId, deps.tx);
    const label = AGENCY_LABELS[n.agency] ?? n.agency;
    return {
      title: `File response ${d.n} to ${n.formCode} notice ${n.id} with ${label}`,
      diff: [{ label: "Notice status", before: n.status, after: "resolved" }],
      content: [{ label: "Content to be sent", text: d.body }],
      moneyCents: null, subjectRef: n.id, subjectHash: sha256Hex(canonicalJson({ notice: n.id, draft: d.n, body: sha256Hex(d.body) })),
      evidence: [{ label: "Notice", ref: n.id }, { label: "Draft", ref: `${n.id}#draft-${d.n}` }, { label: "Not reversible", ref: NOT_REVERSIBLE_REASONS["notices.send_response"]! }],
    };
  },
  async run(i, ctx, deps) {
    const { n, acct, d } = await latestDraft(i, ctx.companyId, deps.tx);
    const ref = (acct?.credentialRef ?? `vault:${n.agency.replace("_", "-")}-portal`) as `vault:${string}`;
    const credential = await deps.resolveCredential(ref);
    const { confirmation } = await deps.sims.agency.fileResponse({ agency: n.agency as never, noticeId: n.id, body: d.body, credential });
    const resolution = { outcome: "response_filed", draft_n: d.n, resolved_at: ctx.now, reversible: false, not_reversible_reason: NOT_REVERSIBLE_REASONS["notices.send_response"] };
    await deps.tx.update(notices).set({ status: "resolved", responseConfirmation: confirmation, resolutionJson: JSON.stringify(resolution) }).where(eq(notices.id, n.id));
    return {
      data: { notice_id: n.id, draft_n: d.n, status: "resolved", confirmation, not_reversible_reason: NOT_REVERSIBLE_REASONS["notices.send_response"] },
      summary: `Filed response ${d.n} to ${n.id} with ${AGENCY_LABELS[n.agency] ?? n.agency}; notice resolved`,
      events: [{ type: "notice.resolved", subjectRef: n.id, payload: { notice_id: n.id } }],
    };
  },
});

export const noticeWriteCommands: WeftCommand[] = [draftResponse, sendResponse];
