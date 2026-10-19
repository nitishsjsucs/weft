"use client";
// A reports.query answer in the agent panel (wave 3, w3-parity-chat). The chart spec and the rows come from the tool
// result (or the run artifact the executor saved), never from model text. Colors are design-system tokens in a fixed
// order validated for color-vision deficiency on the light surface; every chart has a legend for two or more series
// and an accessible data table, so identity and values never depend on color alone.
import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Link from "next/link";
import { Table2 } from "lucide-react";
import { formatCents, ReportResult, W3_CHAT_TID, type ChartSpec } from "@weft/contracts";
import { client, errorText } from "@/lib/api/hooks";
import { fmtDate } from "../format";
import type { ReportRef } from "./run-steps";

/** Fixed categorical order (never cycled): blue-11, accent-9, violet-9, green-9, amber-11, then gray for a sixth. */
// No brand accent here: the accent is for primary actions and the Inbox count, and a red series reads as an error.
export const SERIES_COLORS = ["var(--blue-11)", "var(--violet-9)", "var(--green-9)", "var(--amber-11)", "var(--gray-9)", "var(--blue-9)"] as const;
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

/** The x label for a row: a period's label when the report has one, else the x key's value. A "(to date)" the server
 * put on the current period is dropped here; the chart marks that period itself (see periodLabel and tickLabel). */
const TO_DATE = / \(to date\)$/;
const xLabel = (spec: ChartSpec, r: Row) => String(r[`${spec.x.key}_label`] ?? r[spec.x.key] ?? "").replace(TO_DATE, "");

/** "Jan 1 to Oct 26, 2026" within a year, "Nov 1, 2025 to Oct 26, 2026" across years. */
export function rangeText(from: string, to: string): string {
  const full = { month: "short", day: "numeric", year: "numeric" } as const;
  return from.slice(0, 4) === to.slice(0, 4) ? `${fmtDate(from)} to ${fmtDate(to, full)}` : `${fmtDate(from, full)} to ${fmtDate(to, full)}`;
}
const lastDayOf = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
/** The last period when the range stops inside it (the current month): its bar is a month to date, not a whole month. */
export function partialPeriod(report: Pick<ReportResult, "to">, rows: Row[]): { key: string; label: string } | null {
  const last = rows[rows.length - 1];
  if (!last || typeof last.period_end !== "string" || last.period_end !== report.to) return null;
  if (Number(report.to.slice(8, 10)) === lastDayOf(report.to)) return null;
  return { key: String(last.period ?? ""), label: String(last.period_label ?? last.period ?? "").replace(TO_DATE, "") };
}
/** The long label (tooltip and table): "Oct 2026 (to date)" for the partial period, else the period's own label. */
export function periodLabel(spec: ChartSpec, r: Row, partial: { key: string } | null): string {
  const l = xLabel(spec, r);
  // The engine's label already says "(to date)" for a cut-short period; the marker is added once, never twice.
  return partial && String(r.period ?? "") === partial.key && !/\(to date\)$/.test(l) ? `${l} (to date)` : l;
}
/** The axis tick: short enough for its band. Within one year a month reads as its name alone (the year is in the
 * range line); the partial period carries an asterisk the footnote explains ("Oct*"). */
export function tickLabel(spec: ChartSpec, r: Row, oneYear: boolean, partial: { key: string } | null = null): string {
  const l = xLabel(spec, r);
  const short = oneYear && /^[A-Z][a-z]{2} \d{4}$/.test(l) ? l.slice(0, 3) : oneYear && /^Q[1-4] \d{4}$/.test(l) ? l.slice(0, 2) : l;
  return partial && String(r.period ?? "") === partial.key ? `${short}*` : short;
}

/** Pixels a tick label needs at the axis' 11 px: a generous per-character width plus a gap to its neighbour. */
const tickNeed = (label: string) => label.length * 6.6 + 8;
/**
 * Every step-th tick is labelled, counted back from the last period so the current (partial) one always shows. The
 * step is the larger of an even thinning for long ranges (about eight labels) and what the band width allows, so a
 * label never runs into its neighbour or past the plot in a narrow panel.
 */
export function tickStep(labels: string[], plotWidth: number): number {
  const n = labels.length;
  if (n === 0) return 1;
  const even = n <= 12 ? 1 : Math.ceil(n / 8);
  if (!(plotWidth > 0)) return even;
  const need = Math.max(...labels.map(tickNeed));
  return Math.max(even, Math.ceil(need / (plotWidth / n)));
}
/**
 * The columns a narrow column (the agent panel) shows: the first two series and their total when the series add up
 * (one unit, stacked), so the figures fit without a sideways scroll. The other series stay in the table for screen
 * readers (sr-only cells), and the Reports page shows every column.
 */
export function compactColumns(spec: ChartSpec): { key: string; label: string; unit: Unit; sum?: string[] }[] {
  const cols: { key: string; label: string; unit: Unit; sum?: string[] }[] = spec.series.slice(0, 2).map((s) => ({ key: s.key, label: s.label, unit: s.unit }));
  const unit = spec.series[0]?.unit;
  if (spec.series.length > 2 && spec.kind === "stacked_bar" && spec.series.every((s) => s.unit === unit)) cols.push({ key: "__total", label: "Total", unit: unit!, sum: spec.series.map((s) => s.key) });
  return cols;
}
const Y_AXIS_W = 48;
const PLOT_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };

function DataTable({ spec, rows, ticks, partial = null }: { spec: ChartSpec; rows: Row[]; ticks: string[]; partial?: { key: string } | null }) {
  // Every series plus their total when they add up; in a narrow column (under 27rem) only the first two and the total
  // show, the rest stay for screen readers, and the period reads as its tick ("Oct*").
  const total = compactColumns(spec).find((c) => c.sum);
  const narrowHidden = (i: number) => (total && i >= 2 ? "@max-[27rem]:sr-only" : "");
  return (
    <table data-testid={W3_CHAT_TID.chartTable} className="w-full border-collapse text-1 tabular-nums">
      <caption className="sr-only">{spec.title}</caption>
      <thead>
        <tr className="text-left text-gray-10">
          <th scope="col" className="py-1 pr-2 align-bottom font-medium">{spec.x.label}</th>
          {spec.series.map((s, i) => <th key={s.key} scope="col" className={`py-1 pl-2 text-right align-bottom leading-tight font-medium ${narrowHidden(i)}`}>{s.label}</th>)}
          {total ? <th scope="col" className="py-1 pl-2 text-right align-bottom font-medium">Total</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-gray-a4 text-gray-12">
            <th scope="row" className="py-1 pr-2 text-left font-normal whitespace-nowrap">
              <span className={total ? "@max-[27rem]:sr-only" : ""}>{periodLabel(spec, r, partial)}</span>
              {total ? <span aria-hidden="true" className="hidden @max-[27rem]:inline">{ticks[i]}</span> : null}
            </th>
            {spec.series.map((s, j) => <td key={s.key} className={`py-1 pl-2 text-right whitespace-nowrap ${narrowHidden(j)}`}>{formatValue(r[s.key], s.unit)}</td>)}
            {total ? <td className="py-1 pl-2 text-right font-medium whitespace-nowrap">{formatValue(total.sum!.reduce((acc, k) => acc + Number(r[k] ?? 0), 0), total.unit)}</td> : null}
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
  // Within one year the ticks name the month only; across years they keep the year. tickStep thins them evenly from
  // the last period back when the band is narrower than a label.
  const oneYear = new Set(rows.map((r) => String(r.period ?? "").slice(0, 4))).size <= 1;
  const partial = partialPeriod(report, rows);
  const data = rows.map((r) => ({ ...r, __x: tickLabel(spec, r, oneYear, partial) }));
  // The plot's width decides how many ticks get a label (tickStep); measured, since the panel and the page differ.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [table, rows.length]);
  const step = tickStep(data.map((d) => d.__x), width - Y_AXIS_W - PLOT_MARGIN.left - PLOT_MARGIN.right);
  const shown = (i: number) => (data.length - 1 - i) % step === 0;
  const xTick = (p: { x?: number | string; y?: number | string; index?: number; payload?: { value?: unknown } }) =>
    shown(p.index ?? 0) ? <text x={p.x} y={p.y} dy={12} textAnchor="middle" fill="var(--gray-10)" fontSize={11}>{String(p.payload?.value ?? "")}</text> : <g />;
  // Color follows the series (its index in the spec), so a series that is all zero in this range keeps its slot
  // empty instead of repainting the others; it is left out of the plot and the legend but stays in the table.
  const drawn = spec.series.map((s, i) => ({ ...s, color: SERIES_COLORS[i] ?? SERIES_COLORS[5] })).filter((s) => rows.some((r) => Number(r[s.key] ?? 0) !== 0));
  const zero = spec.series.filter((s) => !drawn.some((d) => d.key === s.key));
  const many = drawn.length > 1;
  const range = rangeText(report.from, report.to);
  const partialTick = partial ? data[data.length - 1]!.__x : "";
  const axis = { stroke: "var(--gray-a6)", tick: { fill: "var(--gray-10)", fontSize: 11 }, tickLine: false };
  const tooltip = (
    <Tooltip cursor={{ fill: "var(--gray-a3)" }} labelFormatter={(_l, p) => { const r = p?.[0]?.payload as Row | undefined; return r ? periodLabel(spec, r, partial) : String(_l); }} formatter={(v, name) => {
      const s = spec.series.find((x) => x.label === name || x.key === name);
      return [formatValue(v, s?.unit ?? unit), s?.label ?? String(name)];
    }} contentStyle={{ borderRadius: 8, border: "1px solid var(--gray-a5)", fontSize: 12, background: "var(--card, #fff)", color: "var(--gray-12)", padding: "6px 8px" }}
      itemStyle={{ color: "var(--gray-12)", padding: 0 }} labelStyle={{ color: "var(--gray-11)", marginBottom: 2 }} />
  );
  const chart = rows.length === 0 || drawn.length === 0 ? null : spec.kind === "line" ? (
    <LineChart data={data} margin={PLOT_MARGIN}>
      <CartesianGrid vertical={false} stroke="var(--gray-a4)" />
      <XAxis dataKey="__x" {...axis} interval={0} tick={xTick} />
      <YAxis {...axis} axisLine={false} width={Y_AXIS_W} tickFormatter={(v: number) => formatTick(v, unit)} />
      {tooltip}
      {drawn.map((s) => <Line key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={s.color} strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: "var(--card, #fff)" }} activeDot={{ r: 4 }} isAnimationActive={false} />)}
    </LineChart>
  ) : (
    <BarChart data={data} margin={PLOT_MARGIN} barCategoryGap="24%">
      <CartesianGrid vertical={false} stroke="var(--gray-a4)" />
      <XAxis dataKey="__x" {...axis} interval={0} tick={xTick} />
      <YAxis {...axis} axisLine={false} width={Y_AXIS_W} tickFormatter={(v: number) => formatTick(v, unit)} allowDecimals={unit !== "count"} />
      {tooltip}
      {drawn.map((s, i) => (
        <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={spec.kind === "stacked_bar" ? "stack" : undefined}
          stroke="var(--card, #fff)" strokeWidth={spec.kind === "stacked_bar" ? 1 : 0} maxBarSize={36} isAnimationActive={false}
          radius={spec.kind === "stacked_bar" ? (i === drawn.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} />
      ))}
    </BarChart>
  );

  return (
    <figure data-testid={W3_CHAT_TID.chart} data-tour="agent-chart" data-metric={report.metric} data-kind={spec.kind} data-rows={rows.length} className="@container relative m-0 flex flex-col gap-2 rounded-xl border border-gray-a4 bg-card p-3">
      <figcaption className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-gray-12">{spec.title}</span>
          <span className="block text-1 text-gray-10">{range}</span>
        </span>
        <button type="button" onClick={() => setTable((t) => !t)} aria-pressed={table} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-1 text-gray-11 hover:bg-gray-a3 focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:outline-none">
          <Table2 className="size-3.5" />{table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {rows.length === 0 ? <p className="text-1 text-gray-10">No rows in this range.</p> : null}
      {chart && !table && many ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-1 text-gray-11" aria-hidden="true">
          {drawn.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.label}</li>)}
        </ul>
      ) : null}
      {chart && !table ? (
        <div ref={box} className="h-44 w-full" role="img" aria-label={`${spec.title}: ${spec.kind === "line" ? "line" : "bar"} chart of ${spec.series.map((s) => s.label).join(", ")} by ${spec.x.label.toLowerCase()}. The table below has every value.`}>
          <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
        </div>
      ) : null}
      {partial ? <p data-testid="chart-partial-note" className="text-0 text-gray-10">{partialTick} counts {partial.label} to date, through {fmtDate(report.to)}.</p> : null}
      {chart && !table && zero.length > 0 ? <p className="text-0 text-gray-10">Zero in this range, so not drawn: {zero.map((s) => s.label).join(", ")}. The table lists them.</p> : null}
      {/* The table is always in the page for screen readers; the toggle shows it to everyone (in the agent panel, the
          period, two series and the total; DataTable). */}
      <div className={table ? "max-h-56 overflow-auto" : "sr-only"}><DataTable spec={spec} rows={rows} ticks={data.map((d) => d.__x)} partial={partial} /></div>
      {table && compactColumns(spec).some((c) => c.sum) ? <Link href={`/app/reports?metric=${encodeURIComponent(report.metric)}`} className="text-1 text-gray-11 underline underline-offset-2 hover:text-gray-12 @min-[27rem]:hidden">Every column is on the Reports page</Link> : null}
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
