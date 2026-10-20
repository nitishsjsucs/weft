// Warms every route the tour visits once, so the first `next dev` compile of a page does not eat a step's seconds.
// A cold first visit is logged, not asserted. Owner: tour.
import type { FullConfig } from "@playwright/test";

const ROUTES = ["/app", "/app/simulators", "/app/inbox", "/app/compliance", "/app/audit", "/app/payroll", "/app/payroll/pay_2026_10_30", "/app/expenses", "/app/time-off", "/app/hiring", "/portal", "/app/memory", "/app/routines", "/app/settings/permissions", "/app/reports"];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) return;
  for (const path of ROUTES) {
    const started = Date.now();
    try {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(120_000) });
      console.log(`tour warmup ${path} ${res.status} in ${Date.now() - started} ms`);
    } catch (e) {
      console.log(`tour warmup ${path} failed: ${(e as Error).message}`);
    }
  }
}
