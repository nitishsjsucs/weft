// pnpm cf:budget --logs (scripts/cf/lib/log-scan.ts; docs/cloudflare/design.md 6.4 and 10): credential shapes in the
// day's Workers Logs events are counted by prefix, never compared with a loaded secret, and the report holds counts
// only. Fixture events stand in for the observability query API; nothing here reaches Cloudflare. The fixture
// credentials are built at run time and are not real.
import { describe, expect, it } from "vitest";
import { LOG_PAGE, logScanReport, logsQueryBody, scanDayLogs, scanEvents } from "../scripts/cf/lib/log-scan";

const PROVIDER_KEY = ["sk", "fixture" + "0".repeat(24)].join("-");
const MCP_KEY = ["wk", "mcp", "slot-1", "3", "Fx".repeat(12)].join("_");
const WEFT_KEY = ["weft", "sk", "0f".repeat(12)].join("_");
const CTX = "v1." + "a".repeat(24) + "." + "b".repeat(30);

const event = (id: string, extra: Record<string, unknown> = {}) => ({
  $metadata: { id, service: "weft", message: "request handled", level: "info" },
  $workers: { scriptName: "weft", outcome: "ok", event: { request: { url: "https://weft.example.test/api/v1/company", method: "GET", headers: { accept: "application/json" } } } },
  timestamp: Date.parse("2026-10-26T12:00:00Z"), dataset: "cloudflare-workers", ...extra,
});

const FIXTURE = [
  event("e1"),
  event("e2", { $metadata: { id: "e2", service: "weft-core", message: `provider said ${PROVIDER_KEY} was rejected` } }),
  event("e3", { $workers: { scriptName: "weft-core", event: { request: { headers: { "x-weft-ctx": CTX, "x-weft-principal": "usr_dana" } } } } }),
  event("e4", { source: { msg: `minted ${MCP_KEY} and ${MCP_KEY}` } }),
  // Mentions and redacted values that are not credentials.
  event("e5", { $metadata: { id: "e5", service: "weft", message: "Use the MCP key from your demo company (Bearer wk_mcp_...)" } }),
  event("e6", { $workers: { event: { request: { headers: { "x-weft-proxy": "[redacted]", "x-weft-tables": "employees,payroll_runs" } } } } }),
  event("e7", { source: `x-weft-proxy: ${"c".repeat(40)} ${WEFT_KEY}` }),
];

describe("cf:budget --logs", () => {
  it("counts each credential shape by prefix, and leaves mentions and redacted values alone", () => {
    const c = scanEvents(FIXTURE);
    expect(c.events).toBe(7);
    expect(c.shapes).toEqual({
      "sk- provider key": { events: 1, matches: 1 },
      "Weft API key (weft_sk_)": { events: 1, matches: 1 },
      "MCP key (wk_mcp_)": { events: 1, matches: 2 },
      "x-weft-* credential header with a value": { events: 2, matches: 2 },
    });
    expect(scanEvents([event("clean"), FIXTURE[4]!]).shapes["MCP key (wk_mcp_)"]).toEqual({ events: 0, matches: 0 });
  });

  it("reads the day page by page with a dry query for weft and weft-core, and reports counts only", async () => {
    const bodies: Record<string, unknown>[] = [];
    const first = Array.from({ length: LOG_PAGE }, (_, i) => event(`p1-${i}`));
    first[10] = event("p1-10", { source: `leaked ${PROVIDER_KEY}` });
    const api = {
      post: async <T>(path: string, body: unknown): Promise<T> => {
        expect(path).toBe("/accounts/:account/workers/observability/telemetry/query");
        bodies.push(body as Record<string, unknown>);
        return { events: { events: bodies.length === 1 ? first : FIXTURE } } as T;
      },
    };
    const now = Date.parse("2026-10-26T18:00:00Z");
    const c = await scanDayLogs(api, "2026-10-26", { now });
    expect(c.events).toBe(LOG_PAGE + FIXTURE.length);
    expect(c.truncated).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ view: "events", dry: true, limit: LOG_PAGE, timeframe: { from: Date.parse("2026-10-26T00:00:00Z"), to: now } });
    expect(bodies[0]).not.toHaveProperty("offset");
    expect(bodies[1]).toMatchObject({ offset: `p1-${LOG_PAGE - 1}` });
    expect(JSON.stringify(bodies[0]!.parameters)).toContain('"value":"weft-core"');
    const r = logScanReport("2026-10-26", c);
    expect(r.found).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toContain("sk- provider key: 2 events, 2 matches");
    for (const secret of [PROVIDER_KEY, MCP_KEY, WEFT_KEY, CTX]) expect(text).not.toContain(secret);
    expect(logScanReport("2026-10-26", { ...scanEvents([event("ok")]), truncated: false }).found).toBe(false);
  });

  it("stops at the day's cap and says so; refuses a day that has not started", async () => {
    const page = Array.from({ length: LOG_PAGE }, (_, i) => event(`x-${i}`));
    let n = 0;
    // Every page is full and ends on a new id, so only the cap stops the read.
    const api = { post: async <T>(): Promise<T> => { n++; return { events: { events: page.map((e) => ({ ...e, $metadata: { ...e.$metadata, id: `${n}-${e.$metadata.id}` } })) } } as T; } };
    const c = await scanDayLogs(api, "2026-10-26", { now: Date.parse("2026-10-27T01:00:00Z"), maxEvents: LOG_PAGE * 2 });
    expect([c.events, c.truncated, n]).toEqual([LOG_PAGE * 2, true, 2]);
    expect(logScanReport("2026-10-26", c).lines[0]).toContain("the day holds more");
    expect(() => logsQueryBody("2026-10-26", Date.parse("2026-10-25T00:00:00Z"))).toThrow(/has not started yet/);
    expect(logsQueryBody("2026-10-26", Date.parse("2026-10-28T00:00:00Z")).timeframe).toEqual({ from: Date.parse("2026-10-26T00:00:00Z"), to: Date.parse("2026-10-27T00:00:00Z") });
  });
});
