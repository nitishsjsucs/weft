// notices.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
// Concise reads return only structured fields (kind, form, dates, status, the parser's extract). Notice titles,
// bodies and agency confirmations are untrusted and appear only in the detailed format, which taints the run.
import { z } from "zod";
import type { WeftCommand } from "../shared/deps";
import { isDetailed, notFound, readCommand, responseFormatField } from "../demo/define";
import { AGENCY_LABELS } from "../tax/queries";
import { earlierCopyOf, getNotice, listNotices, noticeProposals, parseDrafts, parseExtract } from "../notices/queries";
import { noticeWriteCommands } from "../notices/writes";

const NoticeStatus = z.enum(["new", "in_review", "proposed", "resolved", "escalated"]);

const ListInput = z.object({ status: NoticeStatus.optional(), limit: z.number().int().optional(), ...responseFormatField });
type ListInput = z.infer<typeof ListInput>;
const noticesList = readCommand({
  name: "notices.list", domain: "tax",
  summary: "List agency notices with kind, form, dates and status.",
  description: "List agency notices (newest last) with agency, kind, form code, file name, received and respond-by dates, status and the matched tax account. Filter by status. Concise returns structured fields only; detailed adds the notice title, which is untrusted agency text.",
  input: ListInput,
  untrustedFields: ["notices.*.title"],
  async run(i: ListInput, ctx, deps) {
    const rows = await listNotices(deps.tx, ctx.companyId, i.status);
    const limit = Math.min(Math.max(i.limit ?? 20, 1), 50);
    const list = rows.slice(-limit).map((n) => ({
      id: n.id, agency: n.agency, agency_label: AGENCY_LABELS[n.agency] ?? n.agency, kind: n.kind, form_code: n.formCode, file_name: n.fileName,
      received_at: n.receivedAt, respond_by: n.respondBy, status: n.status, tax_account_id: n.taxAccountId,
      ...(isDetailed(i) ? { title: n.title } : {}),
    }));
    return { data: { total: rows.length, count: list.length, notices: list }, summary: `Listed ${list.length} notices` };
  },
});

const GetInput = z.object({ notice_id: z.string(), ...responseFormatField });
type GetInput = z.infer<typeof GetInput>;
const noticesGet = readCommand({
  name: "notices.get", domain: "tax",
  summary: "Read one notice: parsed fields, status and drafts; detailed adds the body.",
  description: "Read one agency notice by notice_id: agency, kind, form, dates, status, matched tax account, the parser's extracted fields (account, tax year, effective date, old and new rates), draft count, the proposals already filed about it and duplicate_of (an earlier copy of the same letter). Detailed adds the title, body and any agency confirmation; that text is untrusted.",
  input: GetInput,
  untrustedFields: ["notice.title", "notice.body", "notice.response_confirmation"],
  async run(i: GetInput, ctx, deps) {
    const n = await getNotice(deps.tx, ctx.companyId, i.notice_id);
    if (!n) throw notFound("notice", i.notice_id);
    const drafts = parseDrafts(n.draftsJson);
    const notice: Record<string, unknown> = {
      id: n.id, agency: n.agency, agency_label: AGENCY_LABELS[n.agency] ?? n.agency, kind: n.kind, form_code: n.formCode, file_name: n.fileName,
      received_at: n.receivedAt, respond_by: n.respondBy, status: n.status, tax_account_id: n.taxAccountId,
      extracted: parseExtract(n.extractedJson), draft_count: drafts.length, has_confirmation: !!n.responseConfirmation,
      // Fix group duplicate-proposal: what is already filed about this notice, and whether it repeats an earlier letter.
      proposals: await noticeProposals(deps.tx, ctx.companyId, n.id), duplicate_of: await earlierCopyOf(deps.tx, ctx.companyId, n),
    };
    if (isDetailed(i)) {
      notice.title = n.title;
      notice.body = n.bodyText;
      notice.response_confirmation = n.responseConfirmation ?? "";
      notice.latest_draft = drafts.at(-1) ? { n: drafts.at(-1)!.n, created_at: drafts.at(-1)!.created_at } : null;
    }
    return { data: { notice }, summary: `Read ${n.fileName}` };
  },
});

export const noticesCommands: WeftCommand[] = [noticesList, noticesGet, ...noticeWriteCommands];
