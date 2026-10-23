// Finishes and checks the static export for Workers static assets (docs/cloudflare/design.md 3.5; track cf5-web).
//
//   node scripts/cf-export.ts post-build   after `next build`: writes out/_redirects and out/_headers, then checks,
//                                          when WEFT_STATIC_EXPORT=1; does nothing on a Node build
//   node scripts/cf-export.ts write        the same, unconditionally
//   node scripts/cf-export.ts check        checks out/ (pnpm --filter @weft/web cf:check-export)
//
// _redirects serves one shell per dynamic section: `/app/<section>/<id>/...` rewrites (200) to the `_` shell's HTML,
// RSC payload and segment files. _headers sets the security headers on every path and, per route, a CSP whose
// script-src lists the sha256 of each inline script in that route's HTML (the export inlines its RSC payload).
// The check proves: every route the app directory defines was exported (every Node route, plus the hosted pages
// on a hosted build), no proxy code reached the export, both files are within Workers' rule limits, and every inline
// script is covered by its route's CSP. Self-contained (node: modules only), so Node runs it without a build step.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Workers static assets limits (developers.cloudflare.com/workers/static-assets/): _headers 100 rules and 2,000
// characters a line; _redirects 2,000 static and 100 dynamic rules, 1,000 characters a rule; 20,000 files of at most
// 25 MiB each.
export const LIMITS = { headerRules: 100, headerLine: 2_000, staticRedirects: 2_000, dynamicRedirects: 100, redirectLine: 1_000, files: 20_000, fileBytes: 25 * 1024 * 1024 } as const;

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** Strings only src/proxy.ts holds; none may reach the export. */
export const PROXY_MARKERS = ["proxy.secret", "HOST_NOT_ALLOWED", "Host not allowed"] as const;
export const SHELL = "_";

export interface Route {
  /** "/", "/app/people", "/app/people/_" (a dynamic shell). */
  path: string;
  /** The `[id]` section of a shell ("people" for /app/people/_), else null. */
  shellOf: string | null;
}

// ---- routes from the app directory -------------------------------------------------------------------------

/** Every page route under `appDir`. `hosted` adds the page.hosted.tsx pages (the hosted build's page extension). */
export function appRoutes(appDir: string, hosted: boolean): Route[] {
  const out: Route[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith("_") || name.startsWith("@")) continue;   // private folders and parallel slots
        walk(full, [...segs, name]);
      } else if (name === "page.tsx" || (hosted && name === "page.hosted.tsx")) {
        const kept = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
        const dyn = kept.findIndex((s) => /^\[[^\]]+\]$/.test(s));
        const path = "/" + kept.map((s) => (/^\[[^\]]+\]$/.test(s) ? SHELL : s)).join("/");
        out.push({ path: path === "/" ? "/" : path.replace(/\/$/, ""), shellOf: dyn > 0 ? kept[dyn - 1]! : null });
      }
    }
  };
  walk(appDir, []);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The export's HTML file for a route (trailingSlash: true). */
export function htmlFile(route: string): string {
  return route === "/" ? "index.html" : `${route.slice(1)}/index.html`;
}
/** The RSC payload the client router fetches on navigation. */
export function rscFile(route: string): string {
  return route === "/" ? "index.txt" : `${route.slice(1)}/index.txt`;
}

// ---- inline scripts and CSP ---------------------------------------------------------------------------------

const NON_SCRIPT_TYPES = /^(application\/(ld\+)?json|text\/template|importmap|speculationrules)$/i;

/** The text of every inline script a browser would run (raw, exactly as the CSP hash is computed). */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (type && NON_SCRIPT_TYPES.test(type)) continue;
    out.push(m[2] ?? "");
  }
  return out;
}

export function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export interface CspOptions { publicOrigin?: string | null; unsafeInline?: boolean }

/** The CSP for one route: scripts and frames from self and Turnstile, connections to self, nothing may frame it. */
export function buildCsp(hashes: string[], o: CspOptions = {}): string {
  const ws = o.publicOrigin ? o.publicOrigin.replace(/^http/, "ws").replace(/\/+$/, "") : null;
  const script = ["'self'", ...(o.unsafeInline ? ["'unsafe-inline'"] : [...new Set(hashes)]), TURNSTILE_ORIGIN];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws ? ` ${ws}` : ""}`,
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The `_headers` path pattern for a route: exact for static routes; one placeholder segment for a shell. */
export function headerPattern(r: Route): string {
  if (r.path === "/") return "/";
  if (r.shellOf) return `${r.path.slice(0, -SHELL.length)}:id/`;
  return `${r.path}/`;
}

/**
 * The baseline policy on every path: what each route's policy also says, but with 'unsafe-inline' for scripts, so a
 * path no route rule matches (the 404 page) still cannot be framed and loads nothing from elsewhere. Workers joins
 * the headers of every matching rule with a comma, which is two policies both enforced: on a route the stricter
 * hash policy decides inline scripts (a policy with hashes ignores 'unsafe-inline'; this one has none).
 */
export function baselineCsp(o: CspOptions = {}): string { return buildCsp([], { ...o, unsafeInline: true }); }

export const GLOBAL_HEADERS: [string, string][] = [
  ["Referrer-Policy", "same-origin"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=(self), payment=()"],
];

export interface RouteCsp { route: Route; pattern: string; hashes: string[]; csp: string; fallback: boolean }

/** CSP per route from its exported HTML. A route whose rule would pass the line limit falls back to 'unsafe-inline'. */
export function routeCsps(outDir: string, routes: Route[], o: CspOptions = {}): RouteCsp[] {
  return routes.map((route) => {
    const html = readFileSync(join(outDir, htmlFile(route.path)), "utf8");
    const hashes = [...new Set(inlineScripts(html).map(sha256Source))];
    let csp = buildCsp(hashes, o);
    let fallback = false;
    if (`  Content-Security-Policy: ${csp}`.length > LIMITS.headerLine) { csp = buildCsp([], { ...o, unsafeInline: true }); fallback = true; }
    return { route, pattern: headerPattern(route), hashes, csp, fallback };
  });
}

/** The first line of _headers records the build it was made for, so `check` checks the same route set. */
export const HEADERS_STAMP = "# Weft static export (apps/web/scripts/cf-export.ts). Generated; do not edit.";
export function buildHeaders(csps: RouteCsp[], hosted = false, o: CspOptions = {}): string {
  const lines = [`${HEADERS_STAMP} hosted=${hosted ? 1 : 0}`, "/*"];
  for (const [k, v] of GLOBAL_HEADERS) lines.push(`  ${k}: ${v}`);
  lines.push(`  Content-Security-Policy: ${baselineCsp(o)}`);
  lines.push("", "/_next/static/*", "  Cache-Control: public, max-age=31536000, immutable");
  for (const c of csps) lines.push("", c.pattern, `  Content-Security-Policy: ${c.csp}`);
  return `${lines.join("\n")}\n`;
}

/** One 200 rewrite per dynamic section: the HTML (empty splat), index.txt and the segment files of the `_` shell. */
export function buildRedirects(routes: Route[]): string {
  const lines = ["# Weft static export (apps/web/scripts/cf-export.ts). Generated; do not edit.", "# Every record id serves its section's shell; the page reads the real id from the URL."];
  for (const r of routes.filter((x) => x.shellOf)) {
    const base = r.path.slice(0, -SHELL.length);
    lines.push(`${base}:id/* ${r.path}/:splat 200`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- parsing the written files (the check reads them back) ---------------------------------------------------

export interface HeaderRule { pattern: string; headers: [string, string][]; lines: string[] }

export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: [], lines: [line] }; rules.push(cur); continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    cur.lines.push(line);
  }
  return rules;
}

export interface RedirectRule { from: string; to: string; status: number; dynamic: boolean; line: string }

export function parseRedirects(text: string): RedirectRule[] {
  return text.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#")).map((line) => {
    const [from = "", to = "", status = "302"] = line.trim().split(/\s+/);
    return { from, to, status: Number(status), dynamic: /[*:]/.test(from), line };
  });
}

/** Matches a Workers `_redirects` / `_headers` pattern against a path: `:name` is one segment, `*` any rest. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  let re = "^";
  const names: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") { re += "(.*)"; names.push("splat"); continue; }
    if (ch === ":" && /[A-Za-z]/.test(pattern[i + 1] ?? "")) {
      const m = /^:([A-Za-z]\w*)/.exec(pattern.slice(i))!;
      re += "([^/]+)";
      names.push(m[1]!);
      i += m[0].length - 1;
      continue;
    }
    re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  const m = new RegExp(`${re}$`).exec(path);
  if (!m) return null;
  return Object.fromEntries(names.map((n, k) => [n, m[k + 1] ?? ""]));
}

/** Where a request path ends up after `_redirects` (first match wins), or itself. */
export function resolveRedirect(rules: RedirectRule[], path: string): { path: string; status: number | null } {
  for (const r of rules) {
    const p = matchPattern(r.from, path);
    if (!p) continue;
    const to = r.to.replace(/:([A-Za-z]\w*)/g, (_m, k: string) => p[k] ?? "");
    return { path: to, status: r.status };
  }
  return { path, status: null };
}

// ---- writing and checking ---------------------------------------------------------------------------------

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export interface ExportOptions { outDir: string; appDir: string; hosted: boolean; publicOrigin?: string | null; nextDir?: string }

/** Next's internal global-error page is prerendered but never written to the export. */
export const NOT_EXPORTED = new Set(["/_global-error"]);

/** The files a route Next prerendered must have in the export. */
export function exportedFilesFor(route: string): string[] {
  if (route === "/_not-found") return ["_not-found/index.html", "404.html"];
  if (/\.[a-z0-9]+$/i.test(route)) return [route.slice(1)];   // metadata files such as /icon-<hash>.svg
  return [htmlFile(route), rscFile(route)];
}

/** The routes the build that wrote `outDir` prerendered (`.next/prerender-manifest.json`), or null when that build
 * was not the export to `outDir` (a later Node build reuses .next). */
export function builtRoutes(nextDir: string, outDir: string): string[] | null {
  try {
    const detail = JSON.parse(readFileSync(join(nextDir, "export-detail.json"), "utf8")) as { outDirectory?: string; success?: boolean };
    if (!detail.success || resolve(detail.outDirectory ?? "") !== resolve(outDir)) return null;
    const m = JSON.parse(readFileSync(join(nextDir, "prerender-manifest.json"), "utf8")) as { routes?: Record<string, unknown> };
    return Object.keys(m.routes ?? {}).sort();
  } catch { return null; }
}

export function writeExport(o: ExportOptions): { routes: Route[]; csps: RouteCsp[] } {
  const routes = appRoutes(o.appDir, o.hosted);
  const csps = routeCsps(o.outDir, routes, { publicOrigin: o.publicOrigin });
  writeFileSync(join(o.outDir, "_headers"), buildHeaders(csps, o.hosted, { publicOrigin: o.publicOrigin }));
  writeFileSync(join(o.outDir, "_redirects"), buildRedirects(routes));
  return { routes, csps };
}

export interface CheckResult { ok: boolean; errors: string[]; notes: string[]; routes: number; built: number | null; files: number; headerRules: number; redirectRules: number; fallbacks: string[] }

export function checkExport(o: ExportOptions): CheckResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const routes = appRoutes(o.appDir, o.hosted);
  if (!existsSync(o.outDir)) return { ok: false, errors: [`${o.outDir} does not exist: run the export build first`], notes, routes: routes.length, built: null, files: 0, headerRules: 0, redirectRules: 0, fallbacks: [] };

  // 1. Every page route of the app directory was exported, with its RSC payload; the 404 page exists. And every route
  // the build prerendered (Next's own list: pages, /_not-found, the icon) is in the export.
  for (const r of routes) {
    for (const f of [htmlFile(r.path), rscFile(r.path)]) if (!existsSync(join(o.outDir, f))) errors.push(`missing ${f} for route ${r.path}`);
  }
  if (!existsSync(join(o.outDir, "404.html"))) errors.push("missing 404.html");
  const built = o.nextDir ? builtRoutes(o.nextDir, o.outDir) : null;
  if (built) {
    for (const r of built) {
      if (NOT_EXPORTED.has(r)) continue;
      for (const f of exportedFilesFor(r)) if (!existsSync(join(o.outDir, f))) errors.push(`missing ${f} for built route ${r}`);
    }
    const pages = new Set(routes.map((r) => r.path));
    for (const r of built) if (!r.startsWith("/_") && !/\.[a-z0-9]+$/i.test(r) && !pages.has(r)) errors.push(`built route ${r} has no page in the app directory`);
  } else if (o.nextDir) notes.push("no prerender manifest from this export build in .next; checked the app directory's routes only");

  // 2. No proxy code, file count and sizes.
  const files = walkFiles(o.outDir);
  if (files.length > LIMITS.files) errors.push(`${files.length} files, over the ${LIMITS.files} asset limit`);
  for (const f of files) {
    const size = statSync(f).size;
    if (size > LIMITS.fileBytes) errors.push(`${relative(o.outDir, f)} is ${size} bytes, over the 25 MiB asset limit`);
    if (/\.(js|html|txt|json|map)$/.test(f)) {
      const text = readFileSync(f, "utf8");
      for (const m of PROXY_MARKERS) if (text.includes(m)) errors.push(`${relative(o.outDir, f)} contains proxy code ("${m}")`);
    }
    if (/(^|[/\\])(proxy|middleware)[^/\\]*\.js$/.test(relative(o.outDir, f))) errors.push(`${relative(o.outDir, f)} looks like proxy code`);
  }

  // 3. _redirects: present, within limits, and every shell's HTML, payload and segment files resolve to the shell.
  const redirectsPath = join(o.outDir, "_redirects");
  let redirectRules = 0;
  if (!existsSync(redirectsPath)) errors.push("missing _redirects");
  else {
    const rules = parseRedirects(readFileSync(redirectsPath, "utf8"));
    redirectRules = rules.length;
    const dyn = rules.filter((r) => r.dynamic).length;
    if (dyn > LIMITS.dynamicRedirects) errors.push(`_redirects has ${dyn} dynamic rules, over ${LIMITS.dynamicRedirects}`);
    if (rules.length - dyn > LIMITS.staticRedirects) errors.push(`_redirects has ${rules.length - dyn} static rules, over ${LIMITS.staticRedirects}`);
    for (const r of rules) if (r.line.length > LIMITS.redirectLine) errors.push(`_redirects rule over ${LIMITS.redirectLine} characters: ${r.from}`);
    for (const r of routes.filter((x) => x.shellOf)) {
      const dir = r.path;
      const sample = `${dir.slice(0, -SHELL.length)}rec_0001`;
      const shellFiles = readdirSync(join(o.outDir, dir.slice(1)));
      const expect: [string, string][] = [[`${sample}/`, `${dir}/`], ...shellFiles.map((f): [string, string] => [`${sample}/${f}`, `${dir}/${f}`])];
      for (const [from, to] of expect) {
        const got = resolveRedirect(rules, from);
        if (got.path !== to || got.status !== 200) errors.push(`_redirects sends ${from} to ${got.path} (${got.status ?? "no rule"}), expected ${to} (200)`);
      }
      // The section's own list page and its files must not be rewritten.
      const list = dir.slice(0, -SHELL.length - 1);
      for (const f of [`${list}/`, `${list}/index.txt`]) if (resolveRedirect(rules, f).status !== null) errors.push(`_redirects rewrites ${f}, which is a real page`);
    }
  }

  // 4. _headers: present, within limits, global headers, and each route's CSP covers its inline scripts.
  const headersPath = join(o.outDir, "_headers");
  let headerRules = 0;
  const fallbacks: string[] = [];
  if (!existsSync(headersPath)) errors.push("missing _headers");
  else {
    const rules = parseHeaders(readFileSync(headersPath, "utf8"));
    headerRules = rules.length;
    if (rules.length > LIMITS.headerRules) errors.push(`_headers has ${rules.length} rules, over ${LIMITS.headerRules}`);
    for (const r of rules) for (const l of r.lines) if (l.length > LIMITS.headerLine) errors.push(`_headers line over ${LIMITS.headerLine} characters in ${r.pattern}`);
    const global = rules.find((r) => r.pattern === "/*");
    for (const [k, v] of GLOBAL_HEADERS) if (!global?.headers.some(([hk, hv]) => hk === k && hv === v)) errors.push(`_headers /* lacks ${k}: ${v}`);
    const base = global?.headers.find(([k]) => k === "Content-Security-Policy")?.[1] ?? "";
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", `frame-src 'self' ${TURNSTILE_ORIGIN}`]) if (!base.includes(d)) errors.push(`the baseline CSP on /* lacks ${d}`);
    if (/script-src[^;]*'sha256-/.test(base)) errors.push("the baseline CSP on /* must not carry hashes (it would make 'unsafe-inline' void for every page)");
    for (const route of routes) {
      const pattern = headerPattern(route);
      const matching = rules.filter((r) => r.pattern !== "/*" && r.headers.some(([k]) => k === "Content-Security-Policy") && matchPattern(r.pattern, route.shellOf ? `${route.path.slice(0, -SHELL.length)}rec_0001/` : pattern));
      if (matching.length !== 1) { errors.push(`route ${route.path} matches ${matching.length} route CSP rules (expected exactly 1)`); continue; }
      const csp = matching[0]!.headers.find(([k]) => k === "Content-Security-Policy")![1];
      for (const d of ["frame-ancestors 'none'", `frame-src 'self' ${TURNSTILE_ORIGIN}`, "connect-src 'self'"]) if (!csp.includes(d)) errors.push(`CSP for ${route.path} lacks ${d}`);
      if (!/script-src [^;]*https:\/\/challenges\.cloudflare\.com/.test(csp)) errors.push(`CSP for ${route.path} does not allow Turnstile scripts`);
      if (csp.includes("'unsafe-inline'") && /script-src[^;]*'unsafe-inline'/.test(csp)) { fallbacks.push(route.path); continue; }
      const html = readFileSync(join(o.outDir, htmlFile(route.path)), "utf8");
      for (const s of inlineScripts(html)) if (!csp.includes(sha256Source(s))) errors.push(`CSP for ${route.path} misses an inline script hash ${sha256Source(s)}`);
    }
  }
  if (fallbacks.length) notes.push(`'unsafe-inline' fallback on: ${fallbacks.join(", ")}`);
  return { ok: errors.length === 0, errors, notes, routes: routes.length, built: built?.length ?? null, files: files.length, headerRules, redirectRules, fallbacks };
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function main(argv: string[]): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = resolve(here, "..");
  const mode = argv[0] ?? "check";
  const exporting = process.env.WEFT_STATIC_EXPORT === "1";
  if (mode === "post-build" && !exporting) return 0;
  const outDir = join(webDir, "out");
  const appDir = join(webDir, "src", "app");
  // `check` checks the build _headers was written for (its stamp); without one, the environment says.
  const stamp = existsSync(join(outDir, "_headers")) ? /hosted=([01])/.exec(readFileSync(join(outDir, "_headers"), "utf8").split("\n")[0] ?? "")?.[1] : undefined;
  const hosted = mode === "check" && stamp !== undefined ? stamp === "1" : process.env.NEXT_PUBLIC_WEFT_HOSTED === "1";
  const opts: ExportOptions = { outDir, appDir, hosted, publicOrigin: process.env.WEFT_PUBLIC_ORIGIN ?? null, nextDir: join(webDir, ".next") };
  if (mode === "write" || mode === "post-build") {
    if (!existsSync(outDir)) { console.error(`cf-export: ${outDir} does not exist (run next build with WEFT_STATIC_EXPORT=1)`); return 1; }
    const { routes, csps } = writeExport(opts);
    console.log(`cf-export: wrote _redirects (${routes.filter((r) => r.shellOf).length} shell rules) and _headers (${csps.length + 2} rules) for ${routes.length} routes`);
  } else if (mode !== "check") {
    console.error(`cf-export: unknown mode ${mode} (post-build, write or check)`);
    return 2;
  }
  const r = checkExport(opts);
  const rel = (p: string) => p.split(sep).join("/");
  console.log(`cf-export check: ${r.built === null ? "" : `${r.built} routes built (all exported but Next's internal /_global-error), `}${r.routes} page routes${hosted ? " (hosted build)" : ""}, ${r.files} files, _headers ${r.headerRules} rules, _redirects ${r.redirectRules} rules in ${rel(relative(process.cwd(), outDir)) || "."}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  for (const e of r.errors) console.error(`  error: ${e}`);
  if (!r.ok) { console.error(`cf-export check failed with ${r.errors.length} error(s)`); return 1; }
  console.log("cf-export check passed");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
