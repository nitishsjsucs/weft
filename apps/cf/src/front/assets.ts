// Static assets (design 3.5): pages never reach this Worker unless run_worker_first lists them. The [id] shell
// fallback lives here: when Workers assets do not honor the export's `_redirects` 200 rewrites (checked in cf5), the
// five dynamic sections are added to run_worker_first and every /app/<section>/<id>/... path is served from the
// section's `_` shell (its index.html and its RSC payload), which reads the real id from the URL (useRouteId).
import type { FrontEnv } from "../shared/env";

export const SHELL_SECTIONS = ["people", "payroll", "runs", "routines", "offboarding"] as const;
const SHELL = new RegExp(`^/app/(${SHELL_SECTIONS.join("|")})/([^/]+)/(.*)$`);

/** The shell path an [id] page is served from, or null when the path is not a dynamic page. */
export function shellPath(path: string): string | null {
  const m = SHELL.exec(path.endsWith("/") || /\.[a-z]+$/i.test(path) ? path : `${path}/`);
  if (!m || m[2] === "_") return null;
  return `/app/${m[1]}/_/${m[3]}`;
}

export async function serveAssets(req: Request, env: FrontEnv, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const shell = shellPath(url.pathname);
  if (shell) return env.ASSETS.fetch(new Request(new URL(`${shell}${url.search}`, url), req));
  return env.ASSETS.fetch(req);
}
