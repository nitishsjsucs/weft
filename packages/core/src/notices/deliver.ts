// sim.deliver_notice (human-only demo control): renders a notice scenario from the agency simulator, matches its
// account number to a tax account, stores the notice and emits notice.received with the id only.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { NoticeScenario, type Namespace } from "@weft/contracts";
import { notices, taxAccounts } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { riskOf, writeCommand } from "../demo/define";

const DeliverInput = z.object({ scenario: NoticeScenario });

export const deliverNotice = writeCommand({
  // "sim" is not in the frozen Namespace union yet (contract request t2-world #1); human_only, so never a tool.
  name: "sim.deliver_notice" as `${Namespace}.${string}`,
  summary: "Demo control: deliver a simulated agency notice.",
  description: "Demo control (human only): the agency simulator renders the named notice scenario, Weft stores it with the parser's extracted fields matched to a tax account, and emits notice.received.",
  input: DeliverInput, domain: "tax", needs: "edit", effect: "write", risk: riskOf("R1"), approval: "never", access: "human_only", reversible: false,
  preview: null,
  async run(i, ctx, deps) {
    const r = await deps.sims.agency.renderScenario(i.scenario);
    const accounts = r.extracted.accountNumber
      ? await deps.tx.select().from(taxAccounts).where(and(eq(taxAccounts.companyId, ctx.companyId), eq(taxAccounts.accountNumber, r.extracted.accountNumber)))
      : [];
    const account = accounts.find((a) => a.agency === r.agency) ?? accounts[0] ?? null;
    const extracted = { ...r.extracted, taxAccountId: account?.id ?? null };
    const id = await deps.newId("ntc_");
    await deps.tx.insert(notices).values({
      id, companyId: ctx.companyId, agency: r.agency, kind: r.kind, formCode: r.formCode, title: r.title, receivedAt: ctx.now, respondBy: r.respondBy,
      status: "new", taxAccountId: account?.id ?? null, fileName: r.fileName, bodyText: r.bodyText, extractedJson: JSON.stringify(extracted),
      draftsJson: "[]", resolutionJson: null, responseConfirmation: null,
    });
    return {
      data: { notice_id: id, agency: r.agency, kind: r.kind, form_code: r.formCode, file_name: r.fileName, tax_account_id: account?.id ?? null, extract_hash: sha256Hex(canonicalJson(extracted)) },
      summary: `Delivered ${r.fileName} from ${r.agency} as ${id}`,
      events: [{ type: "notice.received", subjectRef: id, payload: { notice_id: id } }],
    };
  },
});
