// The GET sweep (docs/cloudflare/design.md 4.4 and 8.2): every GET route in the route table, with ids that exist in
// the seeded world, the query each route requires and the principal that may read it, except the server-sent event
// streams (they stay open). On the rich world every swept route answers 200 but the few in SWEEP_NOT_FOUND, so a
// 0-rows claim covers each route's whole read path, not its not-found exit.
import { sql } from "drizzle-orm";
import { ROUTES } from "@weft/contracts";
import type { DurableTestWorld } from "./durable-world";

export interface SweepRequest { route: string; path: string; who: string }

/** Routes the rich world cannot answer with 200, and why. Each still runs its lookup read. */
export const SWEEP_NOT_FOUND: Readonly<Record<string, string>> = {
  "/v1/offers/:id/envelope": "no seeded offer was sent through the simulated e-signature vendor; the route's only read is the envelope lookup",
};

/** Concrete requests for every GET route in the route table, with ids that exist in the seeded world. */
export async function getSweep(w: Pick<DurableTestWorld, "storage">): Promise<SweepRequest[]> {
  const one = (q: string) => { try { return String(Object.values((w.storage.sql.exec(q).toArray()[0] ?? {}) as Record<string, unknown>)[0] ?? "none"); } catch { return "none"; } };
  const ids: Record<string, string> = {
    "/v1/workers/:id": one("SELECT id FROM workers ORDER BY id LIMIT 1"),
    "/v1/payrolls/:id": one("SELECT id FROM payroll_runs ORDER BY id LIMIT 1"),
    "/v1/paychecks/:id": one("SELECT id FROM paychecks ORDER BY id LIMIT 1"),
    "/v1/notices/:id": one("SELECT id FROM notices ORDER BY id LIMIT 1"),
    "/v1/proposals/:id": one("SELECT id FROM proposals ORDER BY id LIMIT 1"),
    "/v1/actions/:seq": one("SELECT seq FROM actions ORDER BY seq LIMIT 1"),
    "/v1/agent/runs/:id": one("SELECT id FROM agent_runs ORDER BY id LIMIT 1"),
    "/v1/routines/:id": "rt_agency_notice",
    "/v1/routine-runs/:id": one("SELECT id FROM routine_runs ORDER BY id LIMIT 1"),
    "/v1/offers/:id": one("SELECT id FROM offers ORDER BY id LIMIT 1"),
    "/v1/documents/:id": one("SELECT id FROM documents ORDER BY id LIMIT 1"),
    "/v1/offboarding/:id": one("SELECT id FROM offboarding_cases ORDER BY id LIMIT 1"),
    "/v1/expenses/:id": one("SELECT id FROM expenses ORDER BY id LIMIT 1"),
    "/v1/time-off/requests/:id": one("SELECT id FROM time_off_requests ORDER BY id LIMIT 1"),
    "/v1/reports/:metric": "headcount_by_department",
    "/v1/integrations/:vendor": "greenhouse",
    "/v1/screening/orders/:id": one("SELECT id FROM screening_orders ORDER BY id LIMIT 1"),
    "/v1/filings/:id": one("SELECT id FROM filings ORDER BY id LIMIT 1"),
    "/v1/handoffs/:id": one("SELECT id FROM handoff_cases ORDER BY id LIMIT 1"),
  };
  // A run artifact needs its own run (an executor run with an artifact row), when the world has one.
  const artifact = (() => { try { return w.storage.sql.exec<{ id: string; run_id: string }>("SELECT id, run_id FROM run_artifacts ORDER BY id LIMIT 1").toArray()[0] ?? null; } catch { return null; } })();
  const worker = ids["/v1/workers/:id"]!;
  const department = one("SELECT id FROM departments ORDER BY id LIMIT 1");
  // The portal is the new hire persona's own (an employee principal with an offer letter).
  const newHire = one("SELECT p.id FROM principals p JOIN documents d ON d.worker_id = p.worker_id AND d.kind = 'offer_letter' WHERE p.role = 'employee' AND d.offer_id IS NOT NULL ORDER BY p.id LIMIT 1");
  const query: Record<string, string> = {
    "/v1/time-off/ledger": `?workerId=${worker}`,
    "/v1/time-off/calendar": `?departmentId=${department}&from=2026-10-01&to=2026-12-31`,
    "/v1/memory/file": "?path=entities/company/cmp_larkspur.md",
    "/v1/memory/search": "?q=payroll",
    "/v1/memory/history": "?path=entities/company/cmp_larkspur.md",
  };
  const out: SweepRequest[] = [];
  for (const r of ROUTES.filter((x) => x.method === "GET")) {
    if (/\/events$/.test(r.path)) continue;   // server-sent event streams stay open
    let p: string = r.path;
    if (r.path === "/v1/agent/runs/:id/artifacts/:ref" && artifact) p = `/v1/agent/runs/${artifact.run_id}/artifacts/${artifact.id}`;
    if (ids[p]) p = p.replace(/:[A-Za-z]+/, ids[p]!);
    p = p.replace(/\/workers\/:id\//, `/workers/${worker}/`).replace(/\/payrolls\/:id\//, `/payrolls/${ids["/v1/payrolls/:id"]}/`)
      .replace(/\/agent\/runs\/:id\//, `/agent/runs/${ids["/v1/agent/runs/:id"]}/`).replace(/\/routines\/:id\//, "/routines/rt_agency_notice/")
      .replace(/\/routine-runs\/:id\//, `/routine-runs/${ids["/v1/routine-runs/:id"]}/`).replace(/\/offers\/:id\//, `/offers/${ids["/v1/offers/:id"]}/`)
      .replace(/\/expenses\/:id\//, `/expenses/${ids["/v1/expenses/:id"]}/`).replace(/:ref$/, "art_0001").replace(/:[A-Za-z]+/g, "none");
    p += query[r.path] ?? "";
    out.push({ route: r.path, path: p, who: r.path.startsWith("/v1/portal/") && newHire !== "none" ? newHire : "usr_dana" });
  }
  return out;
}

/** The sweep's paths alone (every request but the portal's is usr_dana's). */
export async function getSweepPaths(w: Pick<DurableTestWorld, "storage">): Promise<string[]> {
  return (await getSweep(w)).map((r) => r.path);
}

/** GET routes the sweep covers: every GET in the route table but the event streams. */
export const SWEPT_GET_ROUTES = ROUTES.filter((r) => r.method === "GET" && !/\/events$/.test(r.path));

/**
 * A run artifact (an executor run, its artifact row and its body in the world's run file store), so the artifact
 * route has one to serve: the seeded worlds hold none. Call it before the sweep (it writes rows).
 */
export async function addSweepArtifact(w: Pick<DurableTestWorld, "weft">): Promise<void> {
  const h = await w.weft.executor.runs.openRoutineRun({ routineId: "rt_pre_payroll", routineRunId: "rtr_9400", triggerRef: "manual", attended: false });
  const path = `companies/cmp_larkspur/runs/${h.runId}/artifacts/1-sweep.json`;
  await w.weft.runFiles.write(path, JSON.stringify({ rows: [{ plan: "Medical", enrolled: 41 }] }));
  await w.weft.db.run(sql`INSERT INTO run_artifacts (id, run_id, step_n, path, bytes, sha256, summary, domain, needs, tainted_by) VALUES ('art_9400', ${h.runId}, 1, ${path}, 10, ${"0".repeat(64)}, 'Benefit enrollment', 'benefits', 'view', NULL)`);
}
