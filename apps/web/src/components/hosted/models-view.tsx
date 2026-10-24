"use client";
// The model comparison page (docs/cloudflare/design.md 5.2): hosted run outcomes per provider and model from D1,
// side by side (OpenAI gpt-5.6-luna through AI Gateway against Workers AI gpt-oss-120b, and the scripted provider).
// Aggregates only. Hosted build only.
import { Scale } from "lucide-react";
import { Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { HOSTED_PATHS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import type { ModelComparisonRow } from "../../../../../packages/contracts/src/ext/cf-extras";
import { PageBody, PageHeader } from "../app/page";
import { providerLabel, usdMicros } from "./copy";
import { useHostedGet } from "./use-hosted";

/** "92%" or "Not measured". Exported for tests. */
export function rateText(r: number | null): string { return r === null ? "Not measured" : `${Math.round(r * 100)}%`; }
/** "done 12, failed 1", largest first. */
export function outcomesText(o: Record<string, number>): string {
  const parts = Object.entries(o).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return parts.length ? parts.map(([k, n]) => `${k} ${n}`).join(", ") : "None";
}
/** "1.2 s" or "840 ms". */
export function latencyText(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`; }

export function ModelsView() {
  const q = useHostedGet<ModelComparisonRow[]>(HOSTED_PATHS.models, 60_000);
  const rows = q.data ?? [];
  return (
    <PageBody width="wide">
      <PageHeader title="Model comparison" subtitle="Agent runs on hosted Weft, grouped by the model that ran them. Switch the model for your own workspace on the Simulators page." />
      {q.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{q.error}</div> : null}
      <section>
        <CardHeading icon={<Scale />}>Runs by model, last 7 days</CardHeading>
        <Card className="overflow-x-auto">
          <Table data-testid="models-table">
            <THead><TR><TH>Model</TH><TH className="text-right">Runs</TH><TH className="text-right">Avg steps</TH><TH className="text-right">Grounded</TH><TH className="text-right">Avg cost</TH><TH className="text-right">Avg neurons</TH><TH className="text-right">p50 latency</TH><TH>Outcomes</TH></TR></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={`${r.provider}:${r.model}`} data-provider={r.provider}>
                  <TD><div className="font-medium">{providerLabel(r.provider)}</div><div className="font-mono text-0 text-gray-10">{r.model}</div></TD>
                  <TD className="text-right tabular">{r.runs}</TD>
                  <TD className="text-right tabular">{r.avgSteps.toFixed(1)}</TD>
                  <TD className="text-right tabular">{rateText(r.groundedRate)}</TD>
                  <TD className="text-right tabular">{usdMicros(r.avgCostUsdMicros)}</TD>
                  <TD className="text-right tabular">{Math.round(r.avgNeurons)}</TD>
                  <TD className="text-right tabular">{latencyText(r.p50LatencyMs)}</TD>
                  <TD className="text-1 text-gray-11">{outcomesText(r.outcomes)}</TD>
                </TR>
              ))}
              {!q.loading && rows.length === 0 && !q.error ? <TR><TD colSpan={8} className="text-gray-10">No hosted runs recorded yet.</TD></TR> : null}
            </TBody>
          </Table>
        </Card>
      </section>
    </PageBody>
  );
}
