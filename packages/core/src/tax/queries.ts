// Tax reads shared by tax.* commands and the /v1/tax routes.
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { money, type EmployerRate, type TaxAccount } from "@weft/contracts";
import { employerTaxRates, taxAccounts, type DbTx } from "@weft/db";

export const AGENCY_LABELS: Readonly<Record<string, string>> = {
  irs: "IRS (sim)", ca_edd: "CA EDD (sim)", ny_dtf: "NY DTF (sim)", ny_dol: "NY DOL (sim)", tx_twc: "TX TWC (sim)", co_dor: "CO DOR (sim)", co_cdle: "CO CDLE (sim)",
};

/** Federal FUTA facts shown with the rates (SPEC 5.4). Display only: the credit reduction is year-end, never withheld per paycheck. */
export const FEDERAL_FUTA = {
  futa: { net_rate: "0.006", net_rate_display: "0.6%", wage_base_cents: 700_000, wage_base_display: "$7,000.00", source: "TAX_2026 (synthetic 2026.1 tables)" },
  credit_reduction: [
    { state: "CA", year: 2025, rate: "0.012", rate_display: "1.2%", status: "final" },
    { state: "CA", year: 2026, rate: "0.015", rate_display: "1.5%", status: "projection", note: "Projected; final after Nov 10. Year-end only, not withheld per paycheck." },
  ],
} as const;

export const CO_NEW_EMPLOYER_RATES = [{ code: "sui", rate: "0.0305", wageBaseCents: 3_060_000 }] as const;

export type TaxAccountRow = typeof taxAccounts.$inferSelect;
export type RateRow = typeof employerTaxRates.$inferSelect;

export function toTaxAccountDto(a: TaxAccountRow): TaxAccount {
  return { id: a.id, jurisdiction: a.jurisdiction as TaxAccount["jurisdiction"], agency: a.agency as TaxAccount["agency"], accountType: a.accountType as TaxAccount["accountType"], accountNumber: a.accountNumber, status: a.status as TaxAccount["status"], depositSchedule: a.depositSchedule, registeredAt: a.registeredAt, simApplicationId: a.simApplicationId };
}

export function toRateDto(r: RateRow): EmployerRate {
  return { id: r.id, jurisdiction: r.jurisdiction as EmployerRate["jurisdiction"], code: r.code as EmployerRate["code"], rate: r.rate, wageBase: money(r.wageBaseCents), effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, source: r.source, createdActionSeq: r.createdActionSeq, supersededActionSeq: r.supersededActionSeq };
}

export async function listTaxAccounts(tx: DbTx, companyId: string, jurisdiction?: string): Promise<TaxAccountRow[]> {
  const where = jurisdiction ? and(eq(taxAccounts.companyId, companyId), eq(taxAccounts.jurisdiction, jurisdiction)) : eq(taxAccounts.companyId, companyId);
  return tx.select().from(taxAccounts).where(where).orderBy(asc(taxAccounts.id));
}

export async function listRates(tx: DbTx, companyId: string, opts: { jurisdiction?: string; asOf?: string; includeSuperseded?: boolean } = {}): Promise<RateRow[]> {
  const rows = await tx.select().from(employerTaxRates)
    .where(opts.jurisdiction ? and(eq(employerTaxRates.companyId, companyId), eq(employerTaxRates.jurisdiction, opts.jurisdiction)) : eq(employerTaxRates.companyId, companyId))
    .orderBy(asc(employerTaxRates.jurisdiction), asc(employerTaxRates.code), asc(employerTaxRates.effectiveFrom), asc(employerTaxRates.id));
  return rows.filter((r) => (opts.includeSuperseded || r.supersededActionSeq === null)
    && (!opts.asOf || (r.effectiveFrom <= opts.asOf && (r.effectiveTo === null || r.effectiveTo >= opts.asOf))));
}

/** The active rate row for (jurisdiction, code) in effect on `date`: latest effective_from, not superseded. */
export async function effectiveRate(tx: DbTx, companyId: string, jurisdiction: string, code: string, date: string): Promise<RateRow | null> {
  const rows = await tx.select().from(employerTaxRates).where(and(
    eq(employerTaxRates.companyId, companyId), eq(employerTaxRates.jurisdiction, jurisdiction), eq(employerTaxRates.code, code),
    isNull(employerTaxRates.supersededActionSeq), lte(employerTaxRates.effectiveFrom, date),
    or(isNull(employerTaxRates.effectiveTo), gte(employerTaxRates.effectiveTo, date)),
  )).orderBy(desc(employerTaxRates.effectiveFrom), desc(employerTaxRates.id)).limit(1);
  return rows[0] ?? null;
}
