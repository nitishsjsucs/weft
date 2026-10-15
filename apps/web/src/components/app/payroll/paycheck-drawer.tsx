"use client";
import { Drawer, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import type { Paycheck } from "@weft/contracts";
import { useGet } from "@/lib/api/hooks";
import { cents, hours } from "../format";
import { FlagChip } from "./flag-chip";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-5"><h3 className="mb-2 text-1 font-medium tracking-wide text-gray-10 uppercase">{title}</h3>{children}</section>;
}

/** Paycheck detail with the tax trace (every tax line with its wage base, rate and amount). */
export function PaycheckDrawer({ paycheck, onClose }: { paycheck: Paycheck | null; onClose: () => void }) {
  const detail = useGet("/v1/paychecks/:id", { params: { id: paycheck?.id ?? "" }, enabled: !!paycheck });
  const pc = detail.data ?? paycheck;
  return (
    <Drawer open={!!paycheck} onOpenChange={(o) => { if (!o) onClose(); }} title={pc?.workerName ?? "Paycheck"} description={pc ? `${pc.id} · ${pc.status} · net ${pc.net.display}` : undefined}>
      {pc ? (
        <div data-testid="paycheck-drawer">
          {pc.flags.length ? <div className="mb-4 flex flex-wrap gap-1">{pc.flags.map((f) => <FlagChip key={f.rule} pc={pc} flag={f} />)}</div> : null}
          <Section title="Summary">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
              {([["Gross pay", pc.gross.display], ["Net pay", pc.net.display], ["Employee taxes", pc.employeeTaxes.display], ["Company taxes", pc.companyTaxes.display], ["Company benefits", pc.companyBenefits.display], ["Reimbursements", pc.reimbursements.display], ["Hours", hours(pc.hoursX100)]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-[var(--app-border)] py-1"><dt className="text-gray-11">{k}</dt><dd className="tabular">{v}</dd></div>
              ))}
            </dl>
          </Section>
          <Section title="Earnings">
            {pc.earnings.map((e, i) => <div key={i} className="flex justify-between text-[13px]"><span>{e.type}{e.hoursX100 !== null ? ` (${hours(e.hoursX100)} h)` : ""}</span><span className="tabular">{cents(e.amountCents)}</span></div>)}
          </Section>
          {pc.deductions.length ? (
            <Section title="Deductions">
              {pc.deductions.map((d, i) => <div key={i} className="flex justify-between text-[13px]"><span>{d.code}{d.pretax ? " (pre-tax)" : ""}</span><span className="tabular">{cents(d.amountCents)}</span></div>)}
            </Section>
          ) : null}
          <Section title="Tax trace">
            <Table data-testid="paycheck-tax-trace" className="text-[13px]">
              <THead><TR><TH>Tax</TH><TH>Payer</TH><TH numeric>Taxable wages</TH><TH numeric>Rate</TH><TH numeric>Amount</TH></TR></THead>
              <TBody>
                {pc.taxes.map((t, i) => (
                  <TR key={i}><TD className="h-9 font-mono text-1">{t.jurisdiction} {t.code}</TD><TD className="h-9">{t.payer}</TD><TD numeric className="h-9">{cents(t.taxableWagesCents)}</TD><TD numeric className="h-9">{t.rate ?? "table"}</TD><TD numeric className="h-9">{cents(t.amountCents)}</TD></TR>
                ))}
              </TBody>
            </Table>
            {pc.trace?.length ? (
              <pre className="mt-3 max-h-60 overflow-auto rounded-lg bg-gray-2 p-3 font-mono text-0 leading-4 whitespace-pre-wrap text-gray-11">{pc.trace.join("\n")}</pre>
            ) : null}
          </Section>
        </div>
      ) : null}
    </Drawer>
  );
}
