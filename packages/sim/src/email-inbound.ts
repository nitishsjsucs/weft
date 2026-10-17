// Inbound email for expense submission (wave 4, w4-parity-agent, S5). Owner: w4-parity-agent.
// The simulator stands in for a mailbox: a message names one receipt fixture as its attachment, and the fixture's
// extract stands in for OCR (OCR is deferred past wave 4). Subject and body are the employee's own words and stay
// untrusted. Nothing here reaches a real mail server; every receipt is a generated demo PDF.
import { createHash } from "node:crypto";
import type { SimInboundEmail } from "@weft/contracts";

export interface ReceiptFixture {
  fixture: string; merchant: string; category: "meals" | "travel" | "lodging" | "software" | "supplies";
  amountCents: number; date: string; lines: string[];
}

/** The receipt fixtures a simulated email may attach. Merchants are fictional and marked (demo). */
export const RECEIPT_FIXTURES: Readonly<Record<string, ReceiptFixture>> = {
  lunch_client: { fixture: "lunch_client", merchant: "Juniper Table (demo)", category: "meals", amountCents: 6420, date: "2026-10-22", lines: ["2 lunch specials", "2 iced teas", "Tip"] },
  taxi_airport: { fixture: "taxi_airport", merchant: "Bayline Cabs (demo)", category: "travel", amountCents: 4875, date: "2026-10-21", lines: ["Airport to downtown", "Toll"] },
  hotel_two_nights: { fixture: "hotel_two_nights", merchant: "Harborview Inn (demo)", category: "lodging", amountCents: 21_800, date: "2026-10-20", lines: ["Room, 2 nights", "Occupancy tax"] },
  software_monthly: { fixture: "software_monthly", merchant: "Gridnote Software (demo)", category: "software", amountCents: 1800, date: "2026-10-19", lines: ["Monthly plan"] },
};

export const usdText = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** A small, valid one-page PDF naming the fixture; deterministic, so the same fixture always has the same sha256. */
export function receiptPdf(f: ReceiptFixture): Buffer {
  const text = [`DEMO RECEIPT (synthetic)`, f.merchant, f.date, ...f.lines, `Total ${usdText(f.amountCents)}`].map((l) => l.replace(/[()\\]/g, ""));
  const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${text.map((l) => `(${l}) '`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * The message id of an inbound email: a hash of its canonical content, so the same message delivered twice is one
 * message (the intake row's unique message_ref turns the second delivery into `duplicate`).
 */
export function inboundMessageRef(m: SimInboundEmail): string {
  const canon = JSON.stringify([m.from.trim().toLowerCase(), m.subject, m.body, m.attachment?.fileName ?? null, m.attachment?.fixture ?? null]);
  return `imsg_${createHash("sha256").update(canon).digest("hex").slice(0, 20)}`;
}

/** The fixture an attachment names, or null for a missing or unknown one (both bounce as no receipt). */
export function receiptFixtureOf(m: SimInboundEmail): ReceiptFixture | null {
  return m.attachment ? RECEIPT_FIXTURES[m.attachment.fixture] ?? null : null;
}
