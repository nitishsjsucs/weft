"use client";
// A reports.query answer in the agent panel (wave 3, w3-parity-chat). The chart spec and the rows come from the tool
// result (or the run artifact the executor saved), never from model text. Colors are design-system tokens in a fixed
// order validated for color-vision deficiency on the light surface; every chart has a legend for two or more series
// and an accessible data table, so identity and values never depend on color alone.
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Table2 } from "lucide-react";
import { formatCents, ReportResult, W3_CHAT_TID, type ChartSpec } from "@weft/contracts";
import { client, errorText } from "@/lib/api/hooks";
import type { ReportRef } from "./run-steps";

/** Fixed categorical order (never cycled): blue-11, accent-9, violet-9, green-9, amber-11, then gray for a sixth. */
export const SERIES_COLORS = ["var(--blue-11)", "var(--accent-9)", "var(--violet-9)", "var(--green-9)", "var(--amber-11)", "var(--gray-9)"] as const;
type Unit = ChartSpec["series"][number]["unit"];
type Row = Record<string, string | number>;

export function formatValue(v: unknown, unit: Unit): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n)) return String(v ?? "");
  if (unit === "cents") return formatCents(Math.round(n));
  if (unit === "pct") return `${n.toFixed(2)}%`;
  if (unit === "minutes") return `${(n / 60).toFixed(n % 60 === 0 ? 0 : 1)} h`;
  return n.toLocaleString("en-US");
}
/** Axis ticks stay short: $12.3k, $1.2M, 40 h. */
export function formatTick(v: number, unit: Unit): string {
  if (unit === "cents") {
    const d = v / 100;
    const a = Math.abs(d);
    return a >= 1e6 ? `$${(d / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(d / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k` : `$${d.toFixed(0)}`;
  }
  if (unit === "minutes") return `${Math.round(v / 60)} h`;
  if (unit === "pct") return `${v}%`;
  return String(v);
}

/** The x label for a row: a period's label when the report has one, else the x key's value. */
const xLabel = (spec: ChartSpec, r: Row) => String(r[`${spec.x.key}_label`] ?? r[spec.x.key] ?? "");

function DataTable({ spec, rows }: { spec: ChartSpec; rows: Row[] }) {
  return (
    <table data-testid={W3_CHAT_TID.chartTable} className="w-full border-collapse text-1 tabular-nums">
      <caption className="sr-only">{spec.title}</caption>
      <thead>
        <tr className="text-left text-gray-10">
          <th scope="col" className="py-1 pr-2 font-medium">{spec.x.label}</th>
          {spec.series.map((s) => <th key={s.key} scope="col" className="py-1 pl-2 text-right font-medium">{s.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-gray-a4 text-gray-12">
            <th scope="row" className="py-1 pr-2 text-left font-normal">{xLabel(spec, r)}</th>
            {spec.series.map((s) => <td key={s.key} className="py-1 pl-2 text-right">{formatValue(r[s.key], s.unit)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportChart({ report }: { report: ReportResult }) {
  const spec = report.chart;
  const rows = report.rows as Row[];
  const unit = spec.series[0]!.unit;
  const [table, setTable] = useState(false);
  const data = rows.map((r) => ({ ...r, __x: xLabel(spec, r) }));
  const many = spec.series.length > 1;
  const axis = { stroke: "var(--gray-a6)", tick: { fill: "var(--gray-10)", fontSize: 11 }, tickLine: false };
  const tooltip = (
    <Tooltip cursor={{ fill: "var(--gray-a3)" }} formatter={(v, name) => {
      const s = spec.series.find((x) => x.label === name || x.key === name);
      return [formatValue(v, s?.unit ?? unit), s?.label ?? String(name)];
    }} contentStyle={{ borderRadius: 8, border: "1px solid var(--gray-a5)", fontSize: 12, background: "var(--card, #fff)", color: "var(--gray-12)" }} labelStyle={{ color: "var(--gray-11)" }} />
  );
  const chart = rows.length === 0 ? null : spec.kind === "line" ? (
    <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--gray-a4)" />
      <XAxis dataKey="__x" {...axis} interval="preserveStartEnd" minTickGap={12} />
      <YAxis {...axis} axisLine={false} width={48} tickFormatter={(v: number) => formatTick(v, unit)} />
      {tooltip}
      {many ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--gray-11)" }} /> : null}
      {spec.series.map((s, i) => <Line key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={SERIES_COLORS[i]} strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: "var(--card, #fff)" }} activeDot={{ r: 4 }} isAnimationActive={false} />)}
    </LineChart>
  ) : (
    <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="24%">
      <CartesianGrid vertical={false} stroke="var(--gray-a4)" />
      <XAxis dataKey="__x" {...axis} interval="preserveStartEnd" minTickGap={8} />
      <YAxis {...axis} axisLine={false} width={48} tickFormatter={(v: number) => formatTick(v, unit)} allowDecimals={unit !== "count"} />
      {tooltip}
      {many ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--gray-11)" }} /> : null}
      {spec.series.map((s, i) => (
        <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES_COLORS[i]} stackId={spec.kind === "stacked_bar" ? "stack" : undefined}
          stroke="var(--card, #fff)" strokeWidth={spec.kind === "stacked_bar" ? 1 : 0} maxBarSize={36} isAnimationActive={false}
          radius={spec.kind === "stacked_bar" ? (i === spec.series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} />
      ))}
    </BarChart>
  );

  return (
    <figure data-testid={W3_CHAT_TID.chart} data-metric={report.metric} data-kind={spec.kind} data-rows={rows.length} className="m-0 flex flex-col gap-2 rounded-xl border border-gray-a4 bg-card p-3">
      <figcaption className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-gray-12">{spec.title}</span>
          <span className="block text-1 text-gray-10">{report.from} to {report.to}</span>
        </span>
        <button type="button" onClick={() => setTable((t) => !t)} aria-pressed={table} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-1 text-gray-11 hover:bg-gray-a3 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:outline-none">
          <Table2 className="size-3.5" />{table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {rows.length === 0 ? <p className="text-1 text-gray-10">No rows in this range.</p> : null}
      {chart && !table ? (
        <div className="h-48 w-full" role="img" aria-label={`${spec.title}: ${spec.kind === "line" ? "line" : "bar"} chart of ${spec.series.map((s) => s.label).join(", ")} by ${spec.x.label.toLowerCase()}. The table below has every value.`}>
          <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
        </div>
      ) : null}
      {/* The table is always in the page for screen readers; the toggle shows it to everyone. */}
      <div className={table ? "max-h-56 overflow-auto" : "sr-only"}><DataTable spec={spec} rows={rows} /></div>
    </figure>
  );
}

/** A report from a step: inline data, or the artifact read from GET /v1/agent/runs/:id/artifacts/:ref. */
export function StepReport({ runId, item }: { runId: string; item: ReportRef }) {
  const [state, setState] = useState<{ report: ReportResult | null; error: string | null }>(() => ("report" in item ? { report: item.report, error: null } : { report: null, error: null }));
  const ref = "artifactRef" in item ? item.artifactRef : null;
  useEffect(() => {
    if (!ref) return;
    let live = true;
    client.get("/v1/agent/runs/:id/artifacts/:ref", { params: { id: runId, ref } }).then(
      (a) => {
        const parsed = ReportResult.safeParse((a as { data?: unknown }).data);
        if (live) setState(parsed.success ? { report: parsed.data, error: null } : { report: null, error: "The saved result is not a chart." });
      },
      (e: unknown) => { if (live) setState({ report: null, error: errorText(e) }); },
    );
    return () => { live = false; };
  }, [runId, ref]);
  if (state.report) return <ReportChart report={state.report} />;
  if (state.error) return <p className="text-1 text-red-11">Could not load the chart: {state.error}</p>;
  return <p className="text-1 text-gray-10">Loading the chart...</p>;
}
