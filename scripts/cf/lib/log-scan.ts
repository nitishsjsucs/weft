// pnpm cf:budget --logs (docs/cloudflare/design.md 6.4 and 10): the day's Workers Logs events for weft and weft-core,
// read through the observability query API, scanned for credential shapes by prefix only. No secret is loaded to
// compare against, and nothing an event holds is printed: the result is counts per shape. The query runs with
// `dry: true`, so it saves nothing on the account.
import type { CfApi } from "./cf-api";

/** The credential shapes, by prefix. Each counts events and matches; a match's text is never kept. */
export const LOG_SECRET_SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: "sk- provider key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "Weft API key (weft_sk_)", re: /\bweft_sk_[0-9a-f]{16,}/g },
  // The full hosted MCP key (wk_mcp_<slot>_<gen>_<rand>, cf-hosted.ts), not a mention of the prefix.
  { name: "MCP key (wk_mcp_)", re: /\bwk_mcp_[a-z0-9-]{1,32}_\d{1,9}_[A-Za-z0-9]{16,128}/g },
  // A credential-bearing trust header with a value, as a header map ("x-weft-ctx":"v1...") or a header line
  // (x-weft-proxy: ...). A redacted value ("[redacted]") does not count.
  { name: "x-weft-* credential header with a value", re: /\bx-weft-(?:proxy|ctx|smoke|admin)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi },
];

export interface LogScanCounts {
  events: number;
  /** Per shape: the events holding it and the matches in all. */
  shapes: Record<string, { events: number; matches: number }>;
}

/** Counts the credential shapes in each event's full JSON (metadata, message, request headers, source). */
export function scanEvents(events: readonly unknown[], prior?: LogScanCounts): LogScanCounts {
  const out: LogScanCounts = prior ?? { events: 0, shapes: Object.fromEntries(LOG_SECRET_SHAPES.map((s) => [s.name, { events: 0, matches: 0 }])) };
  for (const ev of events) {
    out.events++;
    let text: string;
    try { text = typeof ev === "string" ? ev : JSON.stringify(ev); } catch { continue; }
    for (const s of LOG_SECRET_SHAPES) {
      const n = text.match(s.re)?.length ?? 0;
      if (n) { out.shapes[s.name]!.events++; out.shapes[s.name]!.matches += n; }
    }
  }
  return out;
}

export const LOG_SCRIPTS = ["weft", "weft-core"] as const;
export const LOG_PAGE = 2000;
/** Weft's share of the Workers Logs allowance (design 8.2): a day never holds more of Weft's events than this. */
export const LOG_MAX_EVENTS = 120_000;

/** The query body for one page of the day's events from weft and weft-core (`offset`: the last event's id). */
export function logsQueryBody(day: string, now: number, offset?: string | null): Record<string, unknown> {
  const from = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(from)) throw new Error(`--day ${day} is not a date`);
  const to = Math.min(from + 86_400_000, now);
  if (to <= from) throw new Error(`--day ${day} has not started yet`);
  return {
    queryId: "weft-cf-budget-logs", view: "events", limit: LOG_PAGE, dry: true, timeframe: { from, to },
    ...(offset ? { offset } : {}),
    parameters: {
      filters: [{ kind: "group", filterCombination: "or", filters: LOG_SCRIPTS.map((s) => ({ key: "$metadata.service", operation: "eq", type: "string", value: s })) }],
    },
  };
}

interface EventsPage { events?: { events?: { $metadata?: { id?: string } }[] } }

/** Reads the day's events page by page and scans each page as it arrives; returns the counts only. */
export async function scanDayLogs(api: Pick<CfApi, "post">, day: string, opts: { now?: number; maxEvents?: number } = {}): Promise<LogScanCounts & { truncated: boolean }> {
  const max = opts.maxEvents ?? LOG_MAX_EVENTS;
  let counts: LogScanCounts | undefined;
  let offset: string | null = null;
  for (;;) {
    const page: EventsPage = await api.post<EventsPage>("/accounts/:account/workers/observability/telemetry/query", logsQueryBody(day, opts.now ?? Date.now(), offset));
    const events = page.events?.events ?? [];
    counts = scanEvents(events, counts);
    const last = events.at(-1)?.$metadata?.id ?? null;
    if (events.length < LOG_PAGE || !last || last === offset) return { ...counts, truncated: false };
    if (counts.events >= max) return { ...counts, truncated: true };
    offset = last;
  }
}

/** The report: counts per shape and whether any was found. Never an event's content. */
export function logScanReport(day: string, c: LogScanCounts & { truncated: boolean }): { lines: string[]; found: boolean } {
  const lines = [`Workers Logs ${day}: ${c.events} events from ${LOG_SCRIPTS.join(" and ")} scanned${c.truncated ? ` (stopped at ${c.events}; the day holds more)` : ""}`];
  let found = false;
  for (const [name, s] of Object.entries(c.shapes)) {
    lines.push(`  ${name}: ${s.events} events, ${s.matches} matches`);
    if (s.matches) found = true;
  }
  return { lines, found };
}
