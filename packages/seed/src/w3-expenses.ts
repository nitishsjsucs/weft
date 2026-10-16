// Seed step w3_expenses (wave 3, docs/wave3.md). Owner: w3-expenses. Deterministic: the policy row, the agent expense
// ceilings, 8 needs_review items (the hand-computed cases E1 to E8 of research/wave3/expenses-timeoff.md 9.2), 4
// approved and 2 declined items of history, and receipt images with sidecar extraction JSON (the simulated extractor
// reads the sidecar; no OCR and no model calls). Every merchant ends with "(demo)".
// Never change wave 1 or wave 2 seed counts and never touch processed runs: nothing is attached to a run here, so the
// open draft pay_2026_10_30 is unchanged. The approved history was imported as approved from the previous expense tool
// and waits for the next draft Weft creates (expenses.schedule on payroll.draft_created).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { W3_CEILINGS, type ExpenseCategory } from "@weft/contracts";
import { expensePolicies, expenses, limits, uploads } from "@weft/db";
import { expenses as exp, newId } from "@weft/core";
import type { SeedContext } from "./context";

/** Agent ceilings: per call, the daily aggregate, and the auto-approval cap (used only at routine autonomy "auto"). */
export const EXPENSE_LIMITS: Record<string, number> = {
  [W3_CEILINGS.expense]: 250_000, [`${W3_CEILINGS.expense}_day`]: 1_000_000,
  [W3_CEILINGS.expenseAuto]: 50_000, [`${W3_CEILINGS.expenseAuto}_day`]: 200_000,
};

interface SeedExpense {
  key: string; workerId: string; category: ExpenseCategory; merchant: string; amountCents: number; transactionDate: string; submittedAt: string;
  purpose: string; attendees?: string; milesX10?: number; tripRef?: string; receipt?: { totalCents: number; date: string };
  status: "needs_review" | "approved" | "declined"; decided?: { at: string; by: string; reason?: string; note?: string };
}

/** E1 to E8 in case order, then the history. Workers are pinned by id (packages/seed/src/people.ts roster order). */
export const SEED_EXPENSES: readonly SeedExpense[] = [
  // E1 clean travel: Mateo Alvarez (demo), CA
  { key: "E1", workerId: "wrk_0005", category: "travel", merchant: "Skyway Air (demo)", amountCents: 41_238, transactionDate: "2026-10-12", submittedAt: "2026-10-13T16:20:00.000Z", purpose: "Flight to the Austin site for the fleet bring-up", receipt: { totalCents: 41_238, date: "2026-10-12" }, status: "needs_review" },
  // E2 meals without attendees, over $75 for one person: Lena Brooks (demo), NY
  { key: "E2", workerId: "wrk_0026", category: "meals", merchant: "Gristmill Diner (demo)", amountCents: 8_640, transactionDate: "2026-10-20", submittedAt: "2026-10-21T14:05:00.000Z", purpose: "Client lunch", receipt: { totalCents: 8_640, date: "2026-10-20" }, status: "needs_review" },
  // E3 supplies under $75 without a receipt: Arturo Silva (demo), TX technician
  { key: "E3", workerId: "wrk_0043", category: "supplies", merchant: "Austin Parts Depot (demo)", amountCents: 4_800, transactionDate: "2026-10-19", submittedAt: "2026-10-20T15:00:00.000Z", purpose: "Zip ties and labels for the fleet bay", status: "needs_review" },
  // E4 equipment over $1,000 without pre-approval, CA Hardware: Kofi Mensah (demo)
  { key: "E4", workerId: "wrk_0018", category: "equipment", merchant: "Benchline Instruments (demo)", amountCents: 124_900, transactionDate: "2026-10-14", submittedAt: "2026-10-15T18:30:00.000Z", purpose: "Bench power supply for actuator tests", receipt: { totalCents: 124_900, date: "2026-10-14" }, status: "needs_review" },
  // E5 lodging without a receipt: Kenji Watanabe (demo), NY
  { key: "E5", workerId: "wrk_0034", category: "lodging", merchant: "Harborview Hotel (demo)", amountCents: 28_900, transactionDate: "2026-10-15", submittedAt: "2026-10-19T13:40:00.000Z", purpose: "Customer workshop, one night", status: "needs_review" },
  // E6 mileage at 76 cents (84.0 miles on Oct 6): Mateo Alvarez (demo)
  { key: "E6", workerId: "wrk_0005", category: "mileage", merchant: "Personal car (demo)", amountCents: 6_384, milesX10: 840, transactionDate: "2026-10-06", submittedAt: "2026-10-07T23:10:00.000Z", purpose: "Drive to the Fremont supplier and back", status: "needs_review" },
  // E7 duplicate of an approved item (same merchant, amount and date): Victor Huang (demo), TX
  { key: "E7", workerId: "wrk_0041", category: "software", merchant: "Fleetlog Cloud (demo)", amountCents: 9_600, transactionDate: "2026-10-01", submittedAt: "2026-10-22T16:00:00.000Z", purpose: "Fleet log analysis seat", receipt: { totalCents: 9_600, date: "2026-10-01" }, status: "needs_review" },
  // E8 past the 60-day window (81 days): Wren Calloway (demo), CA
  { key: "E8", workerId: "wrk_0019", category: "meals", merchant: "Lakeside Bistro (demo)", amountCents: 5_420, transactionDate: "2026-07-31", submittedAt: "2026-10-20T19:45:00.000Z", purpose: "Customer dinner after the pilot review", attendees: "Wren Calloway, two customer engineers", receipt: { totalCents: 5_420, date: "2026-07-31" }, status: "needs_review" },
  // History: approved (imported, waiting for the next draft)
  { key: "H1", workerId: "wrk_0041", category: "software", merchant: "Fleetlog Cloud (demo)", amountCents: 9_600, transactionDate: "2026-10-01", submittedAt: "2026-10-02T15:00:00.000Z", purpose: "Fleet log analysis seat", receipt: { totalCents: 9_600, date: "2026-10-01" }, status: "approved", decided: { at: "2026-10-14T17:00:00.000Z", by: "usr_dana" } },
  { key: "H2", workerId: "wrk_0007", category: "travel", merchant: "Bayline Rail (demo)", amountCents: 6_450, transactionDate: "2026-10-08", submittedAt: "2026-10-09T17:30:00.000Z", purpose: "Train to the Sacramento integrator", receipt: { totalCents: 6_450, date: "2026-10-08" }, status: "approved", decided: { at: "2026-10-14T17:05:00.000Z", by: "usr_dana" } },
  { key: "H3", workerId: "wrk_0023", category: "office", merchant: "Paperworks Supply (demo)", amountCents: 3_275, transactionDate: "2026-10-13", submittedAt: "2026-10-14T14:10:00.000Z", purpose: "Binders for the audit files", receipt: { totalCents: 3_275, date: "2026-10-13" }, status: "approved", decided: { at: "2026-10-15T16:00:00.000Z", by: "usr_dana" } },
  { key: "H4", workerId: "wrk_0037", category: "mileage", merchant: "Personal car (demo)", amountCents: 9_120, milesX10: 1_200, transactionDate: "2026-10-09", submittedAt: "2026-10-10T21:00:00.000Z", purpose: "Site visit to the San Marcos depot", status: "approved", decided: { at: "2026-10-15T16:05:00.000Z", by: "usr_dana" } },
  // History: declined
  { key: "D1", workerId: "wrk_0028", category: "meals", merchant: "Corner Cafe (demo)", amountCents: 2_300, transactionDate: "2026-10-03", submittedAt: "2026-10-04T18:00:00.000Z", purpose: "Weekend brunch", attendees: "Talia Brennan", receipt: { totalCents: 2_300, date: "2026-10-03" }, status: "declined", decided: { at: "2026-10-06T16:00:00.000Z", by: "usr_dana", reason: "personal", note: "Not a business meal." } },
  { key: "D2", workerId: "wrk_0024", category: "travel", merchant: "Cityride Taxi (demo)", amountCents: 12_600, transactionDate: "2026-10-05", submittedAt: "2026-10-06T13:00:00.000Z", purpose: "Taxi to the airport", status: "declined", decided: { at: "2026-10-07T16:00:00.000Z", by: "usr_dana", reason: "no_receipt", note: "No receipt after two reminders." } },
];

/** A tiny deterministic PNG (16 x 20, grayscale, a few dark "text" rows that differ per receipt). */
export function receiptPng(seed: number): Buffer {
  const w = 16, h = 20;
  const raw = Buffer.alloc((w + 1) * h, 0xff);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    if (y % 3 === 1) for (let x = 2; x < 2 + ((seed * 7 + y * 5) % 11) + 2; x++) raw[y * (w + 1) + 1 + x] = 0x30;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export async function seedW3Expenses(ctx: SeedContext): Promise<void> {
  const { db, companyId } = ctx;
  await db.insert(expensePolicies).values({
    id: await newId(db, "epol_"), companyId, version: exp.EXPENSE_POLICY_V1.version, effectiveFrom: exp.EXPENSE_POLICY_V1.effectiveFrom,
    rulesJson: JSON.stringify(exp.EXPENSE_POLICY_V1.rules), sourcesJson: JSON.stringify(exp.EXPENSE_POLICY_V1.sources),
  });
  for (const [key, cents] of Object.entries(EXPENSE_LIMITS)) await db.insert(limits).values({ companyId, key, cents }).onConflictDoNothing();
  const dir = join(ctx.dataDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const ids: string[] = [];
  for (const [n, s] of SEED_EXPENSES.entries()) {
    const id = await newId(db, "exp_");
    ids.push(id);
    let receiptUploadId: string | null = null;
    let extract: string | null = null;
    if (s.receipt) {
      const png = receiptPng(n + 1);
      const sha = createHash("sha256").update(png).digest("hex");
      const rel = `uploads/${sha}.bin`;
      writeFileSync(join(ctx.dataDir, rel), png);
      extract = JSON.stringify({ merchant: s.merchant, date: s.receipt.date, total_cents: s.receipt.totalCents, source: "simulated extractor (sidecar)" });
      writeFileSync(join(dir, `${sha}.extract.json`), extract);
      receiptUploadId = await newId(db, "upl_");
      await db.insert(uploads).values({ id: receiptUploadId, workerId: s.workerId, purpose: "receipt", fileName: `receipt-${id}.png`, storagePath: rel, bytes: png.length, sha256: sha, createdAt: s.submittedAt });
    }
    await db.insert(expenses).values({
      id, companyId, workerId: s.workerId, category: s.category, merchant: s.merchant, amountCents: s.amountCents, currency: "USD", transactionDate: s.transactionDate,
      submittedAt: s.submittedAt, businessPurpose: s.purpose, attendees: s.attendees ?? null, milesX10: s.milesX10 ?? null, tripRef: s.tripRef ?? null, preApprovalRef: null,
      receiptUploadId, receiptExtractJson: extract, status: s.status === "needs_review" ? "submitted" : s.status, checksJson: "[]",
      approverPrincipalId: s.decided?.by ?? null, decidedBy: s.decided?.by ?? null, decidedAt: s.decided?.at ?? null,
      decisionReasonCode: s.decided?.reason ?? null, decisionNote: s.decided?.note ?? null, policyVersion: exp.EXPENSE_POLICY_V1.version,
    });
  }
  // Checks run after every row exists, so E7 sees its duplicate. History keeps the checks it had when decided.
  for (const id of ids) {
    const row = (await db.select().from(expenses).where(eq(expenses.id, id)))[0]!;
    if (row.status === "submitted") await exp.writeChecks(db, row);
    else await db.update(expenses).set({ checksJson: JSON.stringify((await exp.evaluateRow(db, row)).checks.filter((c) => c.rule !== "DUPLICATE")) }).where(eq(expenses.id, id));
  }
}
