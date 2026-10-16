// documents.* commands (wave 2, docs/wave2.md). Owner: w2-onboarding. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { and as andOp, eq as eqOp, inArray } from "drizzle-orm";
import { z } from "zod";
import { DocumentStatus } from "@weft/contracts";
import { onboardingTasks, simChatMessages, workers } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { displayName } from "../people/names";
import { PORTAL_TASK_TITLES } from "../portal/view";
import { notFound, ptDateOf, readCommand } from "../demo/define";
import { getDocument, listWorkerDocuments, signatureOf, toDocumentDto } from "../documents/queries";
import { createOffer, expireOffers, sendOffer, viewOffer, voidOffer } from "../portal/offers";
import { portalCommands } from "../portal/forms";

const ListInput = z.object({ worker_id: z.string(), status: DocumentStatus.optional() });
const listDocuments = readCommand({
  name: "documents.list", domain: "people",
  summary: "A worker's documents (offer letter, agreements, tax and benefit forms) with status.",
  description: "List a worker's documents: kind (offer_letter, confidentiality_agreement, w4, state_withholding, i9, direct_deposit_auth, benefits_election and others), title, status (pending, sent, signed, voided), sha256 and sent and signed times. Optional status filter. Bodies are not returned.",
  input: ListInput,
  async run(i, ctx, deps) {
    const rows = await listWorkerDocuments(deps.tx, ctx.companyId, i.worker_id, i.status);
    return { data: { worker_id: i.worker_id, documents: rows.map(toDocumentDto) }, summary: `${rows.length} document(s) for ${i.worker_id}` };
  },
});

const GetInput = z.object({ document_id: z.string() });
const getDoc = readCommand({
  name: "documents.get", domain: "people",
  summary: "One document's status, hash and signature record.",
  description: "Read one document by document_id: kind, title, status, sha256, and when signed the signature record (signer principal, typed name, signed_at, document_sha256, action_seq). The body text is not returned.",
  input: GetInput,
  async run(i, ctx, deps) {
    const d = await getDocument(deps.tx, ctx.companyId, i.document_id);
    if (!d) throw notFound("document", i.document_id);
    const s = await signatureOf(deps.tx, d.id);
    return { data: { document: toDocumentDto(d), signature: s ? { id: s.id, signer_principal_id: s.signerPrincipalId, signer_name: s.signerName, signed_at: s.signedAt, document_sha256: s.documentSha256, action_seq: s.actionSeq } : null }, summary: `${d.title}: ${d.status}` };
  },
});

// The offer lifecycle and the portal forms live in documents.* (offer letters, e-signature, W-4, state certificate,
// direct deposit authorization, I-9, benefits election are all DocumentKinds). See docs/tracks/w2-onboarding.md.
export const documentsCommands: WeftCommand[] = [listDocuments, getDoc, createOffer, sendOffer, voidOffer, expireOffers, viewOffer, ...portalCommands];

// documents.list_stragglers: the read behind rt_onboarding_nudge's precheck ------------------------------------

export const NUDGE_CHANNEL = "#new-hires";
const StragglersInput = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const listStragglers = readCommand({
  name: "documents.list_stragglers", domain: "people",
  summary: "Onboarding hires with employee tasks past their due date, and whether they were nudged today.",
  description: "List onboarding or active workers with open employee-owned onboarding tasks whose due date is before as_of (default: today's sim date, PT): the open task kinds and titles, the earliest due date, and nudged_today (a #new-hires post naming them today).",
  input: StragglersInput,
  async run(i, ctx, deps) {
    const asOf = i.as_of ?? ptDateOf(ctx.now);
    const ws = await deps.tx.select().from(workers).where(andOp(eqOp(workers.companyId, ctx.companyId), inArray(workers.status, ["onboarding", "active"])));
    const ids = ws.map((w) => w.id);
    const tasks = ids.length ? await deps.tx.select().from(onboardingTasks).where(andOp(inArray(onboardingTasks.workerId, ids), eqOp(onboardingTasks.owner, "employee"))) : [];
    const posts = (await deps.tx.select().from(simChatMessages).where(eqOp(simChatMessages.channel, NUDGE_CHANNEL))).filter((m) => !m.inbound && ptDateOf(m.ts) === asOf);
    const out = [];
    for (const w of ws.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const open = tasks.filter((t) => t.workerId === w.id && t.status !== "done" && t.dueOn !== null && t.dueOn < asOf);
      if (!open.length) continue;
      const name = displayName(w.firstName, w.lastName);
      out.push({
        worker_id: w.id, name, open_tasks: open.map((t) => t.kind), open_titles: open.map((t) => PORTAL_TASK_TITLES[t.kind as keyof typeof PORTAL_TASK_TITLES] ?? t.kind.replace(/_/g, " ")),
        due_on: open.map((t) => t.dueOn!).sort()[0], nudged_today: posts.some((m) => m.text.includes(name)),
      });
    }
    return { data: { as_of: asOf, stragglers: out }, summary: `${out.length} hire(s) with overdue onboarding tasks as of ${asOf}` };
  },
});
documentsCommands.push(listStragglers);
