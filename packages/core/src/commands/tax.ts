// tax.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import type { WeftCommand } from "../shared/deps";
import { isDetailed, ptDateOf, rateDisplay, readCommand, responseFormatField } from "../demo/define";
import { AGENCY_LABELS, FEDERAL_FUTA, listRates, listTaxAccounts } from "../tax/queries";

const Jurisdiction = z.enum(["US", "CA", "NY", "TX", "CO"]);

const ListRegInput = z.object({ jurisdiction: Jurisdiction.optional(), ...responseFormatField });
type ListRegInput = z.infer<typeof ListRegInput>;
const listRegistrations = readCommand({
  name: "tax.list_registrations", domain: "tax",
  summary: "List agency tax accounts and their registration status.",
  description: "List the company's agency tax accounts (IRS, state withholding and unemployment) with account number, status (not_registered, needs_info, awaiting_state, active) and registration dates. Filter by jurisdiction. by_state tells whether each work state has every account active.",
  input: ListRegInput,
  async run(i: ListRegInput, ctx, deps) {
    const rows = await listTaxAccounts(deps.tx, ctx.companyId, i.jurisdiction);
    const accounts = rows.map((a) => ({
      id: a.id, jurisdiction: a.jurisdiction, agency: a.agency, agency_label: AGENCY_LABELS[a.agency] ?? a.agency, account_type: a.accountType,
      account_number: a.accountNumber, status: a.status, registered_at: a.registeredAt, sim_application_id: a.simApplicationId,
      ...(isDetailed(i) ? { deposit_schedule: a.depositSchedule } : {}),
    }));
    const byState: Record<string, "active" | "incomplete"> = {};
    for (const a of rows) byState[a.jurisdiction] = (byState[a.jurisdiction] ?? "active") === "active" && a.status === "active" ? "active" : "incomplete";
    return { data: { count: accounts.length, by_state: byState, accounts }, summary: `Listed ${accounts.length} tax accounts` };
  },
});

const RatesInput = z.object({ jurisdiction: Jurisdiction.optional(), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ...responseFormatField });
type RatesInput = z.infer<typeof RatesInput>;
const getRates = readCommand({
  name: "tax.get_rates", domain: "tax",
  summary: "Employer tax rates (SUI, ETT) in effect, with sources.",
  description: "Employer-specific tax rates (SUI, ETT) in effect on as_of (default today), each with rate as a decimal string and a display, wage base in cents, effective dates and source (seed, notice:<id>, registration:<id>). Detailed adds superseded history and the federal FUTA facts. Filter by jurisdiction.",
  input: RatesInput,
  async run(i: RatesInput, ctx, deps) {
    const asOf = i.as_of ?? ptDateOf(ctx.now);
    const detailed = isDetailed(i);
    const rows = await listRates(deps.tx, ctx.companyId, { jurisdiction: i.jurisdiction, asOf: detailed ? undefined : asOf, includeSuperseded: detailed });
    const rates = rows.map((r) => ({
      id: r.id, jurisdiction: r.jurisdiction, code: r.code, rate: r.rate, rate_display: rateDisplay(r.rate), wage_base_cents: r.wageBaseCents, wage_base_display: formatCents(r.wageBaseCents),
      effective_from: r.effectiveFrom, effective_to: r.effectiveTo, source: r.source,
      ...(detailed ? { created_action_seq: r.createdActionSeq, superseded_action_seq: r.supersededActionSeq } : {}),
    }));
    return { data: { as_of: asOf, count: rates.length, rates, ...(detailed ? { federal: FEDERAL_FUTA } : {}) }, summary: `Read ${rates.length} employer rates` };
  },
});

export const taxCommands: WeftCommand[] = [listRegistrations, getRates];
