// Weft's PDF templates (design 6.4 and 7.1): the offer letter, a signed agreement and a pay stub, as self-contained
// HTML. Every value is escaped text, the styles are inline, there are no scripts, images, fonts or links, so the
// renderer can load the page with JavaScript off and every request aborted. The output is deterministic for the same
// data (no render time, no random ids), so its sha256 is the R2 cache key. Every page carries the demo banner.
// Track cf6-extras.
import type { PdfKind } from "../../contracts/src/ext/cf-extras";
import { escapeHtml } from "./bytes";

export const PDF_DEMO_BANNER = "DEMO DOCUMENT. Fictional company, fictional people, simulated data. Not a real offer, agreement or pay statement.";

export interface SignatureData { signerName: string; typedName: string; signedAt: string; documentSha256: string }
export interface DocumentPdfData {
  kind: "offer_letter" | "signed_agreement";
  companyName: string;
  documentId: string;
  title: string;
  /** The document body exactly as stored (its sha256 is what the signer saw). */
  bodyText: string;
  sha256: string;
  status: string;
  sentAt: string | null;
  signature: SignatureData | null;
}
export interface PayStubLine { label: string; amountCents: number; detail?: string | null }
export interface PayStubPdfData {
  kind: "pay_stub";
  companyName: string;
  paycheckId: string;
  payrollRunId: string;
  workerName: string;
  periodStart: string;
  periodEnd: string;
  payday: string;
  grossCents: number;
  netCents: number;
  reimbursementsCents: number;
  employeeTaxesCents: number;
  companyTaxesCents: number;
  earnings: PayStubLine[];
  deductions: PayStubLine[];
  taxes: PayStubLine[];
}
export type PdfData = DocumentPdfData | PayStubPdfData;

/** Integer cents to "$1,234.56" (no float math). */
export function usd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

const STYLE = [
  "@page { size: letter; margin: 0.75in; }",
  "html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
  "body { font-family: Helvetica, Arial, sans-serif; color: #1c1b1a; font-size: 11pt; line-height: 1.45; margin: 0; }",
  ".banner { border: 1px solid #b54708; color: #7a2e0e; background: #fff6ed; padding: 6pt 9pt; font-size: 8.5pt; letter-spacing: 0.02em; margin-bottom: 18pt; }",
  "header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #d6d3d1; padding-bottom: 8pt; margin-bottom: 16pt; }",
  ".mark { font-weight: 700; font-size: 14pt; letter-spacing: -0.01em; }",
  ".meta { color: #57534e; font-size: 9pt; text-align: right; }",
  "h1 { font-size: 16pt; margin: 0 0 12pt; }",
  "p.body { white-space: pre-wrap; margin: 0 0 14pt; }",
  "table { width: 100%; border-collapse: collapse; margin: 6pt 0 14pt; font-size: 10pt; }",
  "th, td { text-align: left; padding: 4pt 6pt; border-bottom: 1px solid #e7e5e4; }",
  "th { color: #57534e; font-weight: 600; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }",
  "td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }",
  ".totals td { font-weight: 700; border-bottom: none; }",
  ".sig { border: 1px solid #d6d3d1; padding: 9pt 12pt; margin-top: 12pt; font-size: 10pt; }",
  ".mono { font-family: Menlo, Consolas, monospace; font-size: 8.5pt; word-break: break-all; }",
  "footer { margin-top: 24pt; color: #78716c; font-size: 8pt; }",
].join("\n");

const e = escapeHtml;
const page = (title: string, kindLabel: string, ref: string, inner: string) => [
  "<!doctype html>",
  `<html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title><style>${STYLE}</style></head><body>`,
  `<div class="banner">${e(PDF_DEMO_BANNER)}</div>`,
  `<header><div class="mark">Weft</div><div class="meta">${e(kindLabel)}<br>${e(ref)}</div></header>`,
  inner,
  `<footer>Rendered by Weft from its own records. ${e(PDF_DEMO_BANNER)}</footer>`,
  "</body></html>",
].join("\n");

function documentHtml(d: DocumentPdfData): string {
  const sig = d.signature
    ? `<div class="sig"><strong>Signed electronically</strong><br>Typed name: ${e(d.signature.typedName)} (signer of record ${e(d.signature.signerName)})<br>Signed at: ${e(d.signature.signedAt)}<br>Document sha256 at signing: <span class="mono">${e(d.signature.documentSha256)}</span></div>`
    : `<div class="sig">Not signed yet${d.sentAt ? `; sent ${e(d.sentAt)}` : ""}.</div>`;
  return page(d.title, d.kind === "offer_letter" ? "Offer letter" : "Signed agreement", d.documentId, [
    `<h1>${e(d.title)}</h1>`,
    `<p class="body">${e(d.bodyText)}</p>`,
    sig,
    `<p class="mono">${e(d.companyName)} &middot; document ${e(d.documentId)} &middot; sha256 ${e(d.sha256)}</p>`,
  ].join("\n"));
}

const rows = (lines: PayStubLine[]) => lines.map((l) => `<tr><td>${e(l.label)}${l.detail ? ` <span class="mono">${e(l.detail)}</span>` : ""}</td><td class="num">${e(usd(l.amountCents))}</td></tr>`).join("");
const section = (title: string, lines: PayStubLine[]) => lines.length ? `<table><thead><tr><th>${e(title)}</th><th class="num">Amount</th></tr></thead><tbody>${rows(lines)}</tbody></table>` : "";

function payStubHtml(p: PayStubPdfData): string {
  return page(`Pay stub ${p.paycheckId}`, "Pay stub", p.paycheckId, [
    `<h1>${e(p.workerName)}</h1>`,
    `<table><tbody><tr><td>Employer</td><td>${e(p.companyName)}</td></tr><tr><td>Pay period</td><td>${e(p.periodStart)} to ${e(p.periodEnd)}</td></tr><tr><td>Payday</td><td>${e(p.payday)}</td></tr><tr><td>Pay run</td><td class="mono">${e(p.payrollRunId)}</td></tr></tbody></table>`,
    section("Earnings", p.earnings),
    section("Deductions", p.deductions),
    section("Taxes", p.taxes),
    `<table class="totals"><tbody>`,
    `<tr><td>Gross pay</td><td class="num">${e(usd(p.grossCents))}</td></tr>`,
    `<tr><td>Employee taxes</td><td class="num">${e(usd(p.employeeTaxesCents))}</td></tr>`,
    p.reimbursementsCents ? `<tr><td>Reimbursements</td><td class="num">${e(usd(p.reimbursementsCents))}</td></tr>` : "",
    `<tr><td>Net pay</td><td class="num">${e(usd(p.netCents))}</td></tr>`,
    `<tr><td>Employer taxes (not deducted)</td><td class="num">${e(usd(p.companyTaxesCents))}</td></tr>`,
    `</tbody></table>`,
  ].join("\n"));
}

export function renderPdfHtml(data: PdfData): string {
  return data.kind === "pay_stub" ? payStubHtml(data) : documentHtml(data);
}

export const PDF_KINDS: readonly PdfKind[] = ["offer_letter", "signed_agreement", "pay_stub"];
export const isPdfKind = (s: string): s is PdfKind => (PDF_KINDS as readonly string[]).includes(s);
/** Pdf filenames for Content-Disposition: kind and subject id only, never names. */
export const pdfFileName = (kind: PdfKind, subjectId: string) => `weft-${kind.replace("_", "-")}-${subjectId.replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
