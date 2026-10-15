// Warms the routes the golden paths open, so the first `next dev` compile of each page does not eat a test's
// time budget. Runs once after the web server is up and before any spec. Owner: t6-site.
import type { FullConfig } from "@playwright/test";

const ROUTES = ["/", "/app", "/app/simulators", "/app/inbox", "/app/people", "/app/payroll", "/app/payroll/pay_2026_10_30", "/app/compliance", "/app/routines", "/app/routines/rt_people_digest", "/app/audit"];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) return;
  for (const path of ROUTES) {
    const started = Date.now();
    try {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(90_000) });
      console.log(`e2e warmup ${path} ${res.status} in ${Date.now() - started} ms`);
    } catch (e) {
      console.log(`e2e warmup ${path} failed: ${(e as Error).message}`);
    }
  }
}
