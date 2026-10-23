// GET /api/_hosted/pdf/<PdfKind>/<subject id> inside the visitor's slot (design 6.3 and 7.1). CompanyDO hands the
// request here after verifying x-weft-ctx. The document comes from the world's own read routes, called in process
// with the visitor's principal (so persona scope and 404s are exactly the app's), and is rendered from Weft's
// templates. A PDF already in R2 is served at once; a miss is a mutation-class action (a lease and a fresh human
// grant, never on the read-only showcase) that enqueues one render job on weft-render and answers 202. Concurrent
// misses for the same document enqueue once, and a lost job is enqueued again after PDF_REENQUEUE_MS. Every state
// the client polls through ends: a document too large to render is refused before it is queued, and a render that
// failed for good (the consumer leaves a marker beside the PDF key) answers 503 PDF_RENDER_FAILED or PDF_BUDGET, so
// the client stops polling. Track cf6-extras.
import {
  pdfBrowserReserveMs, pdfFailureKey, pdfFileName, pdfObjectKey, renderPdfHtml, sha256Hex, isPdfKind, BROWSER_SECONDS_PER_DAY, MAX_PDF_HTML_BYTES, PDF_FAILURE_TTL_MS,
  type DocumentPdfData, type ExtrasFlags, type HostedJob, type PayStubPdfData, type PdfData, type PdfKey, type PdfKind, type QueueLike, type R2BucketLike,
} from "@weft/cf-extras";
import { HOSTED_ERRORS, type HostedErrorCode, type WorldMode } from "../../../../../packages/contracts/src/ext/cf-hosted";

export interface PdfRouteDeps {
  world: { slot: string; gen: number; mode: WorldMode; snapshot: string };
  /** From the verified x-weft-ctx. */
  ctx: { human: boolean; smoke: boolean };
  /** An in-process GET on the world's Hono app with the request's own principal headers. */
  app: (path: string) => Promise<Response>;
  files: R2BucketLike;
  render: QueueLike<HostedJob> | null;
  flags: () => Promise<ExtrasFlags>;
  /** Browser milliseconds used today (the Lobby counter), to refuse early once the share is spent. */
  browserMsUsed?: () => Promise<number>;
  newJobId: () => string;
  /** Per DO instance: object key to the time its render was enqueued. */
  pending?: Map<string, number>;
  now?: () => number;
  /** The world's IO_IN_TX guard (design 4.2): R2, the render queue and the Lobby are never called inside a transaction. */
  guard?: { assertNotInTx(what: string): void } | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const hostedError = (code: HostedErrorCode, message: string) => json(HOSTED_ERRORS[code].status, { _tag: HOSTED_ERRORS[code].tag, code, message });
const refused = (status: number, code: string, message: string, retryAfterS?: number) =>
  json(status, { _tag: "Refused", code, message, ...(retryAfterS ? { retryAfterS } : {}) }, retryAfterS ? { "retry-after": String(retryAfterS) } : {});

/** Kind and subject from /api/_hosted/pdf/<kind>/<id> (or the DO's rewritten /_hosted/pdf/<kind>/<id>). */
export function parsePdfPath(path: string): { kind: PdfKind; subjectId: string } | null {
  const m = /\/_hosted\/pdf\/([a-z_]+)\/([A-Za-z0-9_]{3,64})\/?$/.exec(path.split("?")[0]!);
  return m && isPdfKind(m[1]!) ? { kind: m[1]!, subjectId: m[2]! } : null;
}

/** A render still pending after this long is enqueued again (its job may have been lost); retries end well before. */
export const PDF_REENQUEUE_MS = 5 * 60_000;

const secondsToUtcMidnight = (t: number) => {
  const d = new Date(t);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t) / 1000);
};

class Upstream extends Error { constructor(readonly res: Response) { super(`upstream ${res.status}`); } }
async function getJson<T>(deps: PdfRouteDeps, path: string): Promise<T> {
  const res = await deps.app(path);
  if (!res.ok) throw new Upstream(res);
  return (await res.json()) as T;
}

interface DocumentDto { id: string; kind: string; title: string; status: string; sha256: string; sentAt: string | null; bodyText: string; signature: { signerName: string; typedName: string; signedAt: string; documentSha256: string } | null }
interface MoneyDto { amount: number }
interface PaycheckDto { id: string; payrollRunId: string; workerName: string; gross: MoneyDto; net: MoneyDto; reimbursements: MoneyDto; employeeTaxes: MoneyDto; companyTaxes: MoneyDto;
  earnings: { type: string; amountCents: number; hoursX100: number | null }[]; deductions: { code: string; pretax: boolean; amountCents: number }[];
  taxes: { code: string; jurisdiction: string; payer: string; amountCents: number }[] }
interface RunDto { periodStart: string; periodEnd: string; payday: string }

const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The template data for a subject, read through the app's own routes. */
export async function pdfDataFor(deps: PdfRouteDeps, kind: PdfKind, subjectId: string): Promise<PdfData | Response> {
  const company = (await getJson<{ company: { legalName: string } }>(deps, "/v1/company")).company.legalName;
  if (kind === "pay_stub") {
    if (!subjectId.startsWith("pyc_")) return json(404, { _tag: "NotFound", message: `No paycheck ${subjectId}` });
    const p = await getJson<PaycheckDto>(deps, `/v1/paychecks/${subjectId}`);
    const run = await getJson<RunDto>(deps, `/v1/payrolls/${p.payrollRunId}`);
    const stub: PayStubPdfData = {
      kind: "pay_stub", companyName: company, paycheckId: p.id, payrollRunId: p.payrollRunId, workerName: p.workerName, periodStart: run.periodStart, periodEnd: run.periodEnd,
      payday: run.payday, grossCents: p.gross.amount, netCents: p.net.amount, reimbursementsCents: p.reimbursements.amount, employeeTaxesCents: p.employeeTaxes.amount,
      companyTaxesCents: p.companyTaxes.amount,
      earnings: p.earnings.map((e) => ({ label: label(e.type), amountCents: e.amountCents, detail: e.hoursX100 !== null ? `${(e.hoursX100 / 100).toFixed(2)} h` : null })),
      deductions: p.deductions.map((d) => ({ label: d.code, amountCents: d.amountCents, detail: d.pretax ? "pretax" : "post-tax" })),
      taxes: p.taxes.filter((t) => t.payer !== "employer").map((t) => ({ label: t.code, amountCents: t.amountCents, detail: t.jurisdiction })),
    };
    return stub;
  }
  if (!subjectId.startsWith("doc_")) return json(404, { _tag: "NotFound", message: `No document ${subjectId}` });
  const d = await getJson<DocumentDto>(deps, `/v1/documents/${subjectId}`);
  if (kind === "offer_letter" && d.kind !== "offer_letter") return json(404, { _tag: "NotFound", message: `${subjectId} is not an offer letter` });
  if (kind === "signed_agreement" && (d.status !== "signed" || !d.signature)) return json(409, { _tag: "Conflict", message: `${subjectId} is not signed yet` });
  const doc: DocumentPdfData = {
    kind, companyName: company, documentId: d.id, title: d.title, bodyText: d.bodyText, sha256: d.sha256, status: d.status, sentAt: d.sentAt,
    signature: kind === "signed_agreement" && d.signature ? { signerName: d.signature.signerName, typedName: d.signature.typedName, signedAt: d.signature.signedAt, documentSha256: d.signature.documentSha256 } : null,
  };
  return doc;
}

export async function handleHostedPdf(path: string, deps: PdfRouteDeps): Promise<Response> {
  const parsed = parsePdfPath(path);
  if (!parsed) return json(404, { _tag: "NotFound", message: "Use /api/_hosted/pdf/<offer_letter|signed_agreement|pay_stub>/<id>" });
  let data: PdfData | Response;
  try { data = await pdfDataFor(deps, parsed.kind, parsed.subjectId); } catch (e) {
    if (e instanceof Upstream) return new Response(e.res.body, { status: e.res.status, headers: { "content-type": e.res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
    throw e;
  }
  if (data instanceof Response) return data;
  const html = renderPdfHtml(data);
  const sha256 = await sha256Hex(html);
  // The showcase is immutable per snapshot, so its PDFs are shared under the seed prefix; a slot's live under its generation.
  const key: PdfKey = deps.world.mode === "showcase" ? { scope: "seed", snapshot: deps.world.snapshot, sha256 } : { scope: "world", slot: deps.world.slot, gen: deps.world.gen, sha256 };
  const objectKey = pdfObjectKey(key);
  const io = (what: string) => deps.guard?.assertNotInTx(what);
  io("R2.get");
  const cached = await deps.files.get(objectKey);
  if (cached) {
    return new Response(await cached.arrayBuffer(), { status: 200, headers: {
      "content-type": "application/pdf", "content-disposition": `attachment; filename="${pdfFileName(parsed.kind, parsed.subjectId)}"`, "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff", "x-weft-pdf": "cached",
    } });
  }
  if (deps.world.mode === "showcase") return hostedError("LEASE_REQUIRED", "Start your own demo company to render documents");
  if (!deps.ctx.human && !deps.ctx.smoke) return hostedError("TURNSTILE_REQUIRED", "Confirm you are human to render this document");
  if (!(await deps.flags()).pdf || !deps.render) return refused(503, "PDF_DISABLED", "PDF rendering is switched off");
  // The consumer refuses a document over MAX_PDF_HTML_BYTES, so it is refused here, before it is queued.
  if (new TextEncoder().encode(html).length > MAX_PDF_HTML_BYTES) return refused(413, "PDF_TOO_LARGE", "This document is too large to render as a PDF");
  const now = deps.now ?? Date.now;
  const budgetSpent = () => refused(503, "PDF_BUDGET", "Today's PDF rendering time is used up; try again after 00:00 UTC", secondsToUtcMidnight(now()));
  // A render reserves its worst case, so a day with less than that left cannot start one.
  if (deps.browserMsUsed) {
    io("LobbyDO.extrasCounterPeek");
    if ((await deps.browserMsUsed()) + pdfBrowserReserveMs() > BROWSER_SECONDS_PER_DAY * 1000) return budgetSpent();
  }
  const pending = deps.pending;
  // A render that failed for good: answer with its failure until the marker is PDF_FAILURE_TTL_MS old.
  io("R2.head");
  const marker = await deps.files.head(pdfFailureKey(objectKey));
  const markedAt = marker?.customMetadata?.at ? Date.parse(marker.customMetadata.at) : NaN;
  if (marker && Number.isFinite(markedAt) && now() - markedAt < PDF_FAILURE_TTL_MS) {
    pending?.delete(objectKey);
    if (marker.customMetadata?.code === "PDF_BUDGET") return budgetSpent();
    return refused(503, "PDF_RENDER_FAILED", "This document could not be rendered; try again in a few minutes", Math.ceil((PDF_FAILURE_TTL_MS - (now() - markedAt)) / 1000));
  }
  const since = pending?.get(objectKey);
  if (since === undefined || now() - since > PDF_REENQUEUE_MS || (Number.isFinite(markedAt) && markedAt >= since)) {
    if (deps.world.mode !== "slot" && deps.world.mode !== "smoke") return hostedError("WORLD_READ_ONLY", "This world cannot render documents");
    io("Queue.send");
    await deps.render.send({ v: 1, kind: "render.pdf", jobId: deps.newJobId(), slot: deps.world.slot, gen: deps.world.gen, pdf: parsed.kind, subjectId: parsed.subjectId, sha256, html }, { contentType: "json" });
    pending?.set(objectKey, now());
  }
  return json(202, { status: "rendering", retryAfterS: 5 }, { "retry-after": "5" });
}
