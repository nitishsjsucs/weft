"use client";
// Reports (wave 4, w4-parity-admin): the metric catalog, a chart and a table per metric, a date range and a grouping,
// and "Email this report", which files a comms.send_report proposal (nothing is sent until a person approves it in
// the Inbox). The seven wave 3 metrics come from GET /v1/reports/:metric (reports.query); the four wave 4 ones from
// reports.breakdown through POST /v1/tools/:name. Rows, chart spec and totals come from the server, never the browser.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChartColumn, Lock, Mail } from "lucide-react";
import { Badge, Button, Card, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import type { ChartSpec, ReportResult, ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { ReportChart, formatValue } from "../agent/chart";
import { PageHeader } from "../page";
import { W4_ADMIN_TID as T } from "./testids";

type Unit = ChartSpec["series"][number]["unit"];
type Row = Record<string, string | number>;
export interface CatalogRow { metric: string; label: string; unit: Unit; domain: string; snapshot: boolean; source: "reports.query" | "reports.breakdown"; allowed: boolean }
interface ReportData { metric: string; from: string; to: string; rows: Row[]; chart: ChartSpec; range_totals?: Record<string, number | string> }

const field = "h-8 rounded-lg bg-card px-2.5 text-[13px] shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";
const DOMAIN_LABEL: Record<string, string> = { payroll: "Payroll", people: "People", tax: "Taxes" };
const ptToday = (iso: string | undefined) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso)) : null);

/** Every column the rows carry, in a readable order: the x key first, then the chart series, then the rest. */
export function tableColumns(spec: ChartSpec, rows: Row[]): { key: string; label: string; unit: Unit | null }[] {
  const skip = new Set([spec.x.key, `${spec.x.key}_label`, "period_start", "period_end"]);
  const seen = new Set<string>();
  const out: { key: string; label: string; unit: Unit | null }[] = [];
  for (const s of spec.series) { out.push({ key: s.key, label: s.label, unit: s.unit }); seen.add(s.key); }
  for (const r of rows) for (const k of Object.keys(r)) {
    if (skip.has(k) || seen.has(k) || k.endsWith("_display")) continue;
    seen.add(k);
    const unit: Unit | null = k.endsWith("_cents") ? "cents" : k.endsWith("_pct") ? "pct" : k.endsWith("minutes") || k === "minutes_used" ? "minutes" : typeof r[k] === "number" ? "count" : null;
    out.push({ key: k, label: k.replace(/_cents$|_pct$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), unit });
  }
  return out;
}

function ReportTable({ data }: { data: ReportData }) {
  const cols = tableColumns(data.chart, data.rows);
  const label = (r: Row) => String(r[`${data.chart.x.key}_label`] ?? r[data.chart.x.key] ?? "");
  const totals = data.range_totals ?? {};
  const hasTotals = cols.some((c) => c.unit === "cents" && typeof totals[c.key] === "number");
  // One scroller (the Table's own, which fades the edge it runs past); headers wrap to two lines so the figures, not
  // the labels, set each column's width.
  return (
    <div className="min-w-0">
      <Table data-testid={T.table} data-rows={data.rows.length} className="min-w-full tabular-nums">
        <THead>
          <TR>
            <TH scope="col" className="align-bottom">{data.chart.x.label}</TH>
            {cols.map((c) => <TH key={c.key} scope="col" className="h-auto max-w-[7.5rem] py-2 text-right align-bottom leading-tight whitespace-normal">{c.label}</TH>)}
          </TR>
        </THead>
        <TBody>
          {data.rows.map((r, i) => (
            <TR key={i}>
              <TD className="whitespace-nowrap px-2.5 font-medium">{label(r)}</TD>
              {cols.map((c) => <TD key={c.key} className="whitespace-nowrap px-2.5 text-right">{c.unit ? formatValue(r[c.key], c.unit) : String(r[c.key] ?? "")}</TD>)}
            </TR>
          ))}
          {hasTotals ? (
            <TR data-total="true">
              <TD className="font-medium">Total</TD>
              {cols.map((c) => <TD key={c.key} className="whitespace-nowrap text-right font-medium">{c.unit === "cents" && typeof totals[c.key] === "number" ? formatValue(totals[c.key], "cents") : ""}</TD>)}
            </TR>
          ) : null}
        </TBody>
      </Table>
      {data.rows.length === 0 ? <p className="px-3 py-4 text-[13px] text-gray-10">No rows in this range.</p> : null}
    </div>
  );
}

function EmailReport({ metric, from, to, groupBy }: { metric: CatalogRow; from: string; to: string; groupBy: "month" | "quarter" }) {
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState("cfo@larkspur.example");
  const [result, setResult] = useState<ToolOutcome | null>(null);
  const send = useMutation(async () => {
    const list = recipients.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const o = (await client.post("/v1/reports/:metric/send", { params: { metric: metric.metric }, body: { from, to, recipients: list, ...(metric.snapshot ? {} : { groupBy }) } })) as ToolOutcome;
    setResult(o);
    return o;
  });
  const done = result && result.ok && result.status === "pending_approval" ? result : null;
  useEffect(() => { setResult(null); send.reset(); }, [metric.metric, from, to, groupBy]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return <Button size="sm" data-testid={T.emailOpen} onClick={() => setOpen(true)} disabled={!metric.allowed}><Mail /> Email this report</Button>;
  return (
    <Card className="flex w-full flex-col gap-2 p-3">
      <label className="flex flex-col gap-1 text-[13px] text-gray-11">
        Recipients (simulated *.example mailboxes, comma separated)
        <input data-testid={T.emailRecipients} className={`${field} w-full`} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" data-testid={T.emailSend} disabled={send.pending || !!done} onClick={() => void send.run()}>{send.pending ? "Filing" : "File for approval"}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
      {done ? (
        <p data-testid={T.emailResult} data-status="pending_approval" data-proposal={"proposalId" in done ? done.proposalId : ""} className="text-[13px] text-gray-11">
          Waiting for approval. Nothing is sent until someone approves it in the <Link className="underline" href="/app/inbox">Inbox</Link>.
        </p>
      ) : null}
      {result && !result.ok ? <p data-testid={T.emailResult} data-status="refused" className="text-[13px] text-red-11">{result.refusal.message}</p> : null}
      {send.error ? <p data-testid={T.emailResult} data-status="error" className="text-[13px] text-red-11">{errorText(send.error)}</p> : null}
    </Card>
  );
}

function useReport(metric: CatalogRow | null, from: string, to: string, groupBy: "month" | "quarter") {
  const [state, setState] = useState<{ key: string; data: ReportData | null; error: string | null }>({ key: "", data: null, error: null });
  const key = metric && from && to ? `${metric.metric}|${from}|${to}|${groupBy}` : "";
  useEffect(() => {
    if (!metric || !key || !metric.allowed) return;
    let live = true;
    (async () => {
      try {
        let data: ReportData;
        if (metric.source === "reports.query") {
          data = (await client.get("/v1/reports/:metric", { params: { metric: metric.metric }, query: { from, to, groupBy } })) as unknown as ReportData;
        } else {
          const o = (await client.post("/v1/tools/:name", { params: { name: "reports.breakdown" }, body: { metric: metric.metric, from, to, group_by: groupBy } })) as ToolOutcome;
          if (!o.ok) throw new Error(o.refusal.message);
          if (o.status !== "done") throw new Error("reports.breakdown did not answer");
          data = o.data as ReportData;
        }
        if (live) setState({ key, data, error: null });
      } catch (e) {
        if (live) setState({ key, data: null, error: errorText(e) });
      }
    })();
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : { key, data: null, error: null };
}

export function ReportsView() {
  const catalog = useGet("/v1/reports");
  const clock = useGet("/v1/sim/clock");
  const rows = (catalog.data ?? []) as unknown as CatalogRow[];
  const today = ptToday((clock.data as { now?: string } | undefined)?.now);
  const [metricId, setMetricId] = useState<string>("payroll_cost_by_month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [groupBy, setGroupBy] = useState<"month" | "quarter">("month");
  useEffect(() => {
    if (!today || to) return;
    setTo(today);
    setFrom(`${today.slice(0, 4)}-01-01`);
  }, [today]); // eslint-disable-line react-hooks/exhaustive-deps
  const metric = useMemo(() => rows.find((r) => r.metric === metricId) ?? null, [rows, metricId]);
  const report = useReport(metric, from, to, groupBy);
  const asResult = report.data ? ({ ...report.data, artifactRef: null } as unknown as ReportResult) : null;

  return (
    <div data-testid={T.reportsPage} className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Reports" subtitle="Payroll, people and compliance figures computed from the company's own records. Pick a metric, a date range and a grouping; emailing a report files a proposal for approval." />
      <div className="@container"><div className="flex flex-col gap-4 @min-[760px]:flex-row @min-[760px]:items-start">
        <nav aria-label="Metrics" className="hidden w-52 shrink-0 flex-col gap-0.5 @min-[760px]:flex">
          {rows.map((r) => (
            <button key={r.metric} type="button" data-testid={T.metric(r.metric)} aria-current={r.metric === metricId ? "true" : undefined} onClick={() => setMetricId(r.metric)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${r.metric === metricId ? "bg-gray-a3 font-medium text-gray-12" : "text-gray-11 hover:bg-gray-a2"}`}>
              <span className="min-w-0 flex-1">{r.label}</span>
              {r.allowed ? null : <Lock className="size-3 text-gray-9" aria-label="No access" />}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 max-w-full flex-col gap-1 text-1 text-gray-11 @min-[760px]:hidden">
              Metric
              <select data-testid={T.metricSelect} className={`${field} max-w-full`} value={metricId} onChange={(e) => setMetricId(e.target.value)}>
                {rows.map((r) => <option key={r.metric} value={r.metric}>{r.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-1 text-gray-11">From<input data-testid={T.from} type="date" className={field} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-1 text-gray-11">To<input data-testid={T.to} type="date" className={field} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-1 text-gray-11">
              Group by
              <select data-testid={T.groupBy} className={field} value={groupBy} disabled={metric?.snapshot} onChange={(e) => setGroupBy(e.target.value as "month" | "quarter")}>
                <option value="month">Month</option><option value="quarter">Quarter</option>
              </select>
            </label>
            {metric ? <Badge tone="gray">{DOMAIN_LABEL[metric.domain] ?? metric.domain}</Badge> : null}
          </div>
          {metric && !metric.allowed ? (
            <Card className="p-4 text-[13px] text-gray-11">You need view access to {DOMAIN_LABEL[metric.domain] ?? metric.domain} to read this report.</Card>
          ) : null}
          {report.error ? <Card className="p-4 text-[13px] text-red-11">{report.error}</Card> : null}
          {asResult ? (
            <div data-testid={T.chart} data-metric={asResult.metric} data-rows={asResult.rows.length}><ReportChart report={asResult} /></div>
          ) : metric?.allowed && !report.error ? <Card className="flex h-44 items-center justify-center gap-2 text-[13px] text-gray-10"><ChartColumn className="size-4" /> Loading the report</Card> : null}
          {report.data ? <Card className="min-w-0 p-1"><ReportTable data={report.data} /></Card> : null}
          {metric && from && to ? <div className="flex flex-wrap items-center gap-2"><EmailReport metric={metric} from={from} to={to} groupBy={groupBy} /></div> : null}
        </div>
      </div></div>
    </div>
  );
}
