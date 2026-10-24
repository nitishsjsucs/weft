// Seed step "tax" (SPEC 5.4). Owner: t2-world. Agency accounts (CO not registered), employer rates effective
// 2026-01-01, and the resolved NY DOL rate notice from 2026-02-14 (history).
import { employerTaxRates, notices, taxAccounts } from "@weft/db";
import { newId } from "@weft/core";
import type { SeedContext } from "./context";

export const TAX_ACCOUNTS = [
  { jurisdiction: "US", agency: "irs", accountType: "federal", accountNumber: "00-4817265", status: "active", depositSchedule: "monthly", credentialRef: "vault:irs-efile" },
  { jurisdiction: "CA", agency: "ca_edd", accountType: "combined", accountNumber: "000-4817-2", status: "active", depositSchedule: "monthly", credentialRef: "vault:ca-edd-portal" },
  { jurisdiction: "NY", agency: "ny_dtf", accountType: "withholding", accountNumber: "004817265-01-3", status: "active", depositSchedule: "monthly", credentialRef: "vault:ny-dtf-portal" },
  { jurisdiction: "NY", agency: "ny_dol", accountType: "unemployment", accountNumber: "00-48172 6", status: "active", depositSchedule: "quarterly", credentialRef: "vault:ny-dol-portal" },
  { jurisdiction: "TX", agency: "tx_twc", accountType: "unemployment", accountNumber: "00-481726-5", status: "active", depositSchedule: "quarterly", credentialRef: "vault:tx-twc-portal" },
  { jurisdiction: "CO", agency: "co_dor", accountType: "withholding", accountNumber: null, status: "not_registered", depositSchedule: null, credentialRef: "vault:co-dor-portal" },
  { jurisdiction: "CO", agency: "co_cdle", accountType: "unemployment", accountNumber: null, status: "not_registered", depositSchedule: null, credentialRef: "vault:co-cdle-portal" },
] as const;

const NY_NOTICE_TEXT = `NEW YORK STATE DEPARTMENT OF LABOR
Unemployment Insurance Contribution Rate Notice

Notice Date: 2026-02-14
Employer: Larkspur Robotics, Inc.
Employer Account Number: 00-48172 6
Rate Year: 2026
Effective Date: 2026-01-01

Your contribution rate for calendar year 2026:
  Unemployment Insurance (UI): 4.1% (previously 3.8%)
  Taxable wage limit per employee: $17,600
`;

export async function seedTax(ctx: SeedContext): Promise<void> {
  const { db, companyId } = ctx;
  const ids: Record<string, string> = {};
  for (const a of TAX_ACCOUNTS) {
    const id = await newId(db, "txa_");
    ids[a.agency] = id;
    await db.insert(taxAccounts).values({ id, companyId, ...a, registeredAt: a.status === "active" ? "2023-03-01T17:00:00.000Z" : null, simApplicationId: null });
  }
  const noticeId = await newId(db, "ntc_");
  const rates = [
    { jurisdiction: "CA", code: "sui", rate: "0.034", wageBaseCents: 700_000, source: "seed" },
    { jurisdiction: "CA", code: "ett", rate: "0.001", wageBaseCents: 700_000, source: "seed" },
    { jurisdiction: "NY", code: "sui", rate: "0.041", wageBaseCents: 1_760_000, source: `notice:${noticeId}` },
    { jurisdiction: "TX", code: "sui", rate: "0.027", wageBaseCents: 900_000, source: "seed" },
  ];
  for (const r of rates) {
    await db.insert(employerTaxRates).values({ id: await newId(db, "etr_"), companyId, ...r, effectiveFrom: "2026-01-01", effectiveTo: null, createdActionSeq: null, supersededActionSeq: null });
  }
  await db.insert(notices).values({
    id: noticeId, companyId, agency: "ny_dol", kind: "rate_change", formCode: "UI rate notice", title: "Unemployment insurance contribution rate for 2026",
    receivedAt: "2026-02-14T17:00:00.000Z", respondBy: null, status: "resolved", taxAccountId: ids.ny_dol!, fileName: "NY_DOL_UI_RATE_2026.txt",
    bodyText: NY_NOTICE_TEXT,
    extractedJson: JSON.stringify({ agency: "ny_dol", formCode: "UI rate notice", kind: "rate_change", accountNumber: "00-48172 6", taxAccountId: ids.ny_dol!, taxYear: 2026, effectiveFrom: "2026-01-01", respondBy: null, rates: [{ code: "sui", oldRate: "0.038", newRate: "0.041" }], amountCents: null, period: null }),
    draftsJson: "[]", resolutionJson: JSON.stringify({ outcome: "rate_recorded", resolvedAt: "2026-02-16T18:00:00.000Z" }), responseConfirmation: null,
  });
}
