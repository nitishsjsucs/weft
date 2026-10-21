// The GET sweep (docs/cloudflare/design.md 4.4 and 8.2): every GET route in the route table, with ids that exist in
// the seeded world, except the server-sent event streams (they stay open).
import { ROUTES } from "@weft/contracts";
import type { DurableTestWorld } from "./durable-world";

/** Concrete paths for every GET route in the route table, with ids that exist in the seeded world. */
export async function getSweepPaths(w: Pick<DurableTestWorld, "storage">): Promise<string[]> {
  const one = async (q: string) => { try { return String(Object.values((w.storage.sql.exec(q).toArray()[0] ?? {}) as Record<string, unknown>)[0] ?? "none"); } catch { return "none"; } };
  const ids: Record<string, string> = {
    "/v1/workers/:id": await one("SELECT id FROM workers ORDER BY id LIMIT 1"),
    "/v1/payrolls/:id": await one("SELECT id FROM payroll_runs ORDER BY id LIMIT 1"),
    "/v1/paychecks/:id": await one("SELECT id FROM paychecks ORDER BY id LIMIT 1"),
    "/v1/notices/:id": await one("SELECT id FROM notices ORDER BY id LIMIT 1"),
    "/v1/proposals/:id": await one("SELECT id FROM proposals ORDER BY id LIMIT 1"),
    "/v1/actions/:seq": await one("SELECT seq FROM actions ORDER BY seq LIMIT 1"),
    "/v1/agent/runs/:id": await one("SELECT id FROM agent_runs ORDER BY id LIMIT 1"),
    "/v1/routines/:id": "rt_agency_notice",
    "/v1/routine-runs/:id": await one("SELECT id FROM routine_runs ORDER BY id LIMIT 1"),
    "/v1/offers/:id": await one("SELECT id FROM offers ORDER BY id LIMIT 1"),
    "/v1/documents/:id": await one("SELECT id FROM documents ORDER BY id LIMIT 1"),
    "/v1/offboarding/:id": await one("SELECT id FROM offboarding_cases ORDER BY id LIMIT 1"),
    "/v1/expenses/:id": await one("SELECT id FROM expenses ORDER BY id LIMIT 1"),
    "/v1/time-off/requests/:id": await one("SELECT id FROM time_off_requests ORDER BY id LIMIT 1"),
    "/v1/reports/:metric": "headcount",
    "/v1/integrations/:vendor": "greenhouse",
    "/v1/screening/orders/:id": await one("SELECT id FROM screening_orders ORDER BY id LIMIT 1"),
    "/v1/filings/:id": await one("SELECT id FROM filings ORDER BY id LIMIT 1"),
    "/v1/handoffs/:id": await one("SELECT id FROM handoffs ORDER BY id LIMIT 1"),
  };
  const out: string[] = [];
  for (const r of ROUTES.filter((x) => x.method === "GET")) {
    if (/\/events$/.test(r.path)) continue;   // server-sent event streams stay open
    let p: string = r.path;
    if (ids[p]) p = p.replace(/:[A-Za-z]+/, ids[p]!);
    p = p.replace(/\/workers\/:id\//, `/workers/${ids["/v1/workers/:id"]}/`).replace(/\/payrolls\/:id\//, `/payrolls/${ids["/v1/payrolls/:id"]}/`)
      .replace(/\/agent\/runs\/:id\//, `/agent/runs/${ids["/v1/agent/runs/:id"]}/`).replace(/\/routines\/:id\//, "/routines/rt_agency_notice/")
      .replace(/\/routine-runs\/:id\//, `/routine-runs/${ids["/v1/routine-runs/:id"]}/`).replace(/\/offers\/:id\//, `/offers/${ids["/v1/offers/:id"]}/`)
      .replace(/\/expenses\/:id\//, `/expenses/${ids["/v1/expenses/:id"]}/`).replace(/:ref$/, "art_0001").replace(/:[A-Za-z]+/g, "none");
    if (p === "/v1/memory/file") p = "/v1/memory/file?path=knowledge/company.md";
    if (p === "/v1/memory/search") p = "/v1/memory/search?q=payroll";
    if (p === "/v1/memory/history") p = "/v1/memory/history?path=knowledge/company.md";
    out.push(p);
  }
  return out;
}

/** GET routes the sweep covers: every GET in the route table but the event streams. */
export const SWEPT_GET_ROUTES = ROUTES.filter((r) => r.method === "GET" && !/\/events$/.test(r.path));
