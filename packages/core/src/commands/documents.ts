// documents.* commands (wave 2, docs/wave2.md). Owner: w2-onboarding. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { DocumentStatus } from "@weft/contracts";
import type { WeftCommand } from "../shared/deps";
import { notFound, readCommand } from "../demo/define";
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
