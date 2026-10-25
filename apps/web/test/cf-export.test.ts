// The static export's finishing script (track cf5-web; docs/cloudflare/design.md 3.5): routes from the app directory,
// the `_redirects` shells, the per-route CSP hashes in `_headers`, Workers pattern matching, and the check on a
// synthetic export (passing, then each failure it must catch).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appRoutes, buildCsp, VOICE_FILE, VOICE_MODEL_ORIGINS, buildHeaders, buildRedirects, checkExport, exportedFilesFor, headerPattern, htmlFile, inlineScripts, LIMITS, matchPattern, parseHeaders,
  parseRedirects, resolveRedirect, rscFile, sha256Source, TURNSTILE_ORIGIN, writeExport, type Route,
} from "../scripts/cf-export";

const APP_DIR = fileURLToPath(new URL("../src/app", import.meta.url));

describe("appRoutes", () => {
  it("lists the Node pages, with one `_` shell per dynamic section", () => {
    const routes = appRoutes(APP_DIR, false);
    expect(routes).toHaveLength(28);
    expect(routes.map((r) => r.path)).toContain("/");
    // The Agent page selects by query (?thread=, ?run=), so it is one static page with no shell.
    expect(routes.find((r) => r.path === "/app/agent")).toEqual({ path: "/app/agent", shellOf: null });
    expect(routes.map((r) => r.path)).toContain("/portal");
    expect(routes.map((r) => r.path)).toContain("/app/settings/permissions");
    expect(routes.filter((r) => r.shellOf).map((r) => `${r.shellOf}:${r.path}`).sort()).toEqual([
      "offboarding:/app/offboarding/_", "payroll:/app/payroll/_", "people:/app/people/_", "routines:/app/routines/_", "runs:/app/runs/_",
    ]);
    expect(routes.some((r) => r.path.includes("("))).toBe(false);
  });
  it("adds the hosted pages on a hosted build", () => {
    const extra = appRoutes(APP_DIR, true).map((r) => r.path).filter((p) => !appRoutes(APP_DIR, false).some((r) => r.path === p));
    expect(extra.sort()).toEqual(["/app/models", "/app/platform"]);
  });
  it("names each route's export files (trailingSlash)", () => {
    expect([htmlFile("/"), rscFile("/")]).toEqual(["index.html", "index.txt"]);
    expect([htmlFile("/app/people/_"), rscFile("/app/people/_")]).toEqual(["app/people/_/index.html", "app/people/_/index.txt"]);
    expect(exportedFilesFor("/_not-found")).toEqual(["_not-found/index.html", "404.html"]);
    expect(exportedFilesFor("/icon-pwu6ef.svg")).toEqual(["icon-pwu6ef.svg"]);
  });
});

describe("Workers patterns", () => {
  it("matches placeholders as one segment and splats as the rest, empty included", () => {
    expect(matchPattern("/app/people/:id/*", "/app/people/wrk_0026/")).toEqual({ id: "wrk_0026", splat: "" });
    expect(matchPattern("/app/people/:id/*", "/app/people/wrk_0026/index.txt")).toEqual({ id: "wrk_0026", splat: "index.txt" });
    expect(matchPattern("/app/people/:id/*", "/app/people/")).toBeNull();
    expect(matchPattern("/app/people/:id/*", "/app/people/index.txt")).toBeNull();
    expect(matchPattern("/app/people/:id/", "/app/people/wrk_0026/")).toEqual({ id: "wrk_0026" });
    expect(matchPattern("/app/people/", "/app/people/wrk_0026/")).toBeNull();
    expect(matchPattern("/*", "/anything/at/all")).toEqual({ splat: "anything/at/all" });
  });
  it("rewrites every file of a record URL to its section's shell, and leaves the list page alone", () => {
    const routes: Route[] = [{ path: "/app/people", shellOf: null }, { path: "/app/people/_", shellOf: "people" }, { path: "/app/runs/_", shellOf: "runs" }];
    const rules = parseRedirects(buildRedirects(routes));
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.dynamic && r.status === 200)).toBe(true);
    expect(resolveRedirect(rules, "/app/people/wrk_0026/")).toEqual({ path: "/app/people/_/", status: 200 });
    expect(resolveRedirect(rules, "/app/people/wrk_0026/index.txt")).toEqual({ path: "/app/people/_/index.txt", status: 200 });
    expect(resolveRedirect(rules, "/app/people/wrk_0026/__next._tree.txt")).toEqual({ path: "/app/people/_/__next._tree.txt", status: 200 });
    expect(resolveRedirect(rules, "/app/runs/run_0001/")).toEqual({ path: "/app/runs/_/", status: 200 });
    expect(resolveRedirect(rules, "/app/people/").status).toBeNull();
    expect(resolveRedirect(rules, "/app/people/index.txt").status).toBeNull();
  });
});

describe("CSP", () => {
  it("hashes the inline scripts a browser runs, exactly as written", () => {
    const html = `<script src="/_next/a.js" async=""></script><script id="_R_">a()</script><script>self.__next_f.push([1,"x\\n"])</script><script type="application/ld+json">{"a":1}</script>`;
    expect(inlineScripts(html)).toEqual(["a()", `self.__next_f.push([1,"x\\n"])`]);
    expect(sha256Source("a()")).toBe("'sha256-" + createHash("sha256").update("a()").digest("base64") + "'");
  });
  it("allows scripts and frames from self and Turnstile, connections to self, and no framing", () => {
    const csp = buildCsp(["'sha256-AAA='"]);
    expect(csp).toContain(`script-src 'self' 'sha256-AAA=' ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain(`frame-src 'self' ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);   // hashes, not 'unsafe-inline', for scripts
    expect(buildCsp([], { publicOrigin: "https://weft.nitish-ratakonda.workers.dev" })).toContain("connect-src 'self' wss://weft.nitish-ratakonda.workers.dev");
    expect(buildCsp(["'sha256-AAA='"], { unsafeInline: true })).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
  });
  it("lets the in-browser voice model download from Hugging Face and compile its WebAssembly only when the export ships it", () => {
    const csp = buildCsp(["'sha256-AAA='"], { publicOrigin: "https://weft.nitish-ratakonda.workers.dev", voice: true });
    expect(VOICE_MODEL_ORIGINS).toEqual(["https://huggingface.co", "https://*.hf.co"]);
    expect(VOICE_FILE).toBe("assist/voice/weft-voice.bin");
    expect(csp).toContain("connect-src 'self' wss://weft.nitish-ratakonda.workers.dev https://huggingface.co https://*.hf.co;");
    expect(csp).toMatch(/script-src [^;]*'wasm-unsafe-eval'/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).not.toMatch(/script-src [^;]*hf\.co/);
    // Without the voice file the in-browser voice never runs: no third-party connection and no WebAssembly compile.
    const plain = buildCsp(["'sha256-AAA='"], { publicOrigin: "https://weft.nitish-ratakonda.workers.dev" });
    expect(plain).toContain("connect-src 'self' wss://weft.nitish-ratakonda.workers.dev;");
    expect(plain).not.toMatch(/hf\.co|huggingface|wasm-unsafe-eval/);
  });
  it("gives shells a one-segment placeholder rule and static routes exact rules", () => {
    expect(headerPattern({ path: "/", shellOf: null })).toBe("/");
    expect(headerPattern({ path: "/app/people", shellOf: null })).toBe("/app/people/");
    expect(headerPattern({ path: "/app/people/_", shellOf: "people" })).toBe("/app/people/:id/");
  });
  it("writes the global headers, immutable static chunks and one CSP rule per route", () => {
    const text = buildHeaders([{ route: { path: "/", shellOf: null }, pattern: "/", hashes: [], csp: "default-src 'self'", fallback: false }], true);
    const rules = parseHeaders(text);
    expect(text.split("\n")[0]).toMatch(/hosted=1$/);
    expect(rules.map((r) => r.pattern)).toEqual(["/*", "/_next/static/*", "/"]);
    expect(rules[0]!.headers.map(([k]) => k)).toEqual(["Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options", "Permissions-Policy", "Content-Security-Policy"]);
    expect(rules[0]!.headers[4]![1]).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(rules[0]!.headers[4]![1]).toContain("frame-ancestors 'none'");
    expect(rules[1]!.headers).toEqual([["Cache-Control", "public, max-age=31536000, immutable"]]);
  });
});

// ---- a synthetic export ---------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeExport(): { outDir: string; appDir: string } {
  const root = mkdtempSync(join(tmpdir(), "weft-cf-export-"));
  dirs.push(root);
  const appDir = join(root, "app");
  const outDir = join(root, "out");
  const page = (rel: string) => { mkdirSync(join(appDir, rel), { recursive: true }); writeFileSync(join(appDir, rel, "page.tsx"), "export default function P() { return null; }\n"); };
  page("(marketing)");
  page("(app)/app");
  page("(app)/app/people");
  page("(app)/app/people/[id]");
  mkdirSync(join(appDir, "(app)/app/platform"), { recursive: true });
  writeFileSync(join(appDir, "(app)/app/platform/page.hosted.tsx"), "export default function P() { return null; }\n");
  const html = (n: string) => `<!DOCTYPE html><html><head><script src="/_next/static/chunks/a.js" async=""></script></head><body><script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"${n}"])</script></body></html>`;
  const files: Record<string, string> = {
    "index.html": html("home"), "index.txt": "0:home", "404.html": html("404"),
    "app/index.html": html("app"), "app/index.txt": "0:app",
    "app/people/index.html": html("people"), "app/people/index.txt": "0:people",
    "app/people/_/index.html": html("person"), "app/people/_/index.txt": "0:person", "app/people/_/__next._tree.txt": "tree",
    "_next/static/chunks/a.js": "console.log(1)",
  };
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(outDir, rel, ".."), { recursive: true }); writeFileSync(join(outDir, rel), body); }
  return { outDir, appDir };
}

describe("writeExport and checkExport", () => {
  it("writes both files and passes on a sound export", () => {
    const { outDir, appDir } = fakeExport();
    const w = writeExport({ outDir, appDir, hosted: false });
    expect(w.routes.map((r) => r.path)).toEqual(["/", "/app", "/app/people", "/app/people/_"]);
    const r = checkExport({ outDir, appDir, hosted: false });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ ok: true, routes: 4, redirectRules: 1, headerRules: 6 });
    expect(r.fallbacks).toEqual([]);
  });

  it("adds the voice model hosts to connect-src and 'wasm-unsafe-eval' to script-src only once the export ships the voice file", () => {
    const { outDir, appDir } = fakeExport();
    const policies = () => parseHeaders(readFileSync(join(outDir, "_headers"), "utf8")).flatMap((r) => r.headers.filter(([k]) => k === "Content-Security-Policy").map(([, v]) => v));
    const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))!.split(" ").slice(1);
    writeExport({ outDir, appDir, hosted: false });
    const without = policies();
    expect(without.length).toBe(5);
    for (const csp of without) expect(csp).not.toMatch(/huggingface|hf\.co|wasm-unsafe-eval/);
    mkdirSync(join(outDir, "assist/voice"), { recursive: true });
    writeFileSync(join(outDir, VOICE_FILE), "WEFTVOICE1\n");
    writeExport({ outDir, appDir, hosted: false });
    const withVoice = policies();
    expect(withVoice.length).toBe(without.length);
    withVoice.forEach((csp, i) => {
      const before = without[i]!;
      expect(directive(csp, "connect-src")).toEqual([...directive(before, "connect-src"), "https://huggingface.co", "https://*.hf.co"]);
      expect(directive(csp, "script-src")).toEqual([...directive(before, "script-src"), "'wasm-unsafe-eval'"]);
      // Nothing else in the policy moves.
      const rest = (c: string) => c.split("; ").filter((d) => !/^(connect|script)-src /.test(d));
      expect(rest(csp)).toEqual(rest(before));
    });
    expect(checkExport({ outDir, appDir, hosted: false }).errors).toEqual([]);
  });

  it("fails on a hosted build whose hosted page is missing", () => {
    const { outDir, appDir } = fakeExport();
    expect(() => writeExport({ outDir, appDir, hosted: true })).toThrow();   // no HTML to hash for /app/platform
    writeExport({ outDir, appDir, hosted: false });
    const r = checkExport({ outDir, appDir, hosted: true });
    expect(r.errors).toContain("missing app/platform/index.html for route /app/platform");
  });

  it("catches proxy code, a stale CSP hash, a missing shell rule and oversized rules", () => {
    const { outDir, appDir } = fakeExport();
    writeExport({ outDir, appDir, hosted: false });
    writeFileSync(join(outDir, "_next/static/chunks/a.js"), "const f = 'proxy.secret';");
    writeFileSync(join(outDir, "app/people/index.html"), `<script>changed()</script>`);
    writeFileSync(join(outDir, "_redirects"), "# none\n");
    const r = checkExport({ outDir, appDir, hosted: false });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("contains proxy code"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("CSP for /app/people misses an inline script hash"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("_redirects sends /app/people/rec_0001/"))).toBe(true);

    const big = `/a/:x/* /b/:splat 200\n`.repeat(LIMITS.dynamicRedirects + 1);
    writeFileSync(join(outDir, "_redirects"), big);
    expect(checkExport({ outDir, appDir, hosted: false }).errors.some((e) => e.includes("dynamic rules, over 100"))).toBe(true);
  });

  it("keeps the baseline policy on /* free of hashes", () => {
    const { outDir, appDir } = fakeExport();
    writeExport({ outDir, appDir, hosted: false });
    const text = readFileSync(join(outDir, "_headers"), "utf8").replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'sha256-AAA='");
    writeFileSync(join(outDir, "_headers"), text);
    expect(checkExport({ outDir, appDir, hosted: false }).errors).toContain("the baseline CSP on /* must not carry hashes (it would make 'unsafe-inline' void for every page)");
  });

  it("catches a route that two route CSP rules would match (two strict policies both enforced)", () => {
    const { outDir, appDir } = fakeExport();
    writeExport({ outDir, appDir, hosted: false });
    const extra = "\n/app/people/*\n  Content-Security-Policy: default-src 'none'\n";
    writeFileSync(join(outDir, "_headers"), readFileSync(join(outDir, "_headers"), "utf8") + extra);
    expect(checkExport({ outDir, appDir, hosted: false }).errors).toContain("route /app/people/_ matches 2 route CSP rules (expected exactly 1)");
  });

  it("falls back to 'unsafe-inline' for a route whose hashes would pass the line limit", () => {
    const { outDir, appDir } = fakeExport();
    const many = Array.from({ length: 60 }, (_, i) => `<script>s${i}()</script>`).join("");
    writeFileSync(join(outDir, "app/index.html"), many);
    const w = writeExport({ outDir, appDir, hosted: false });
    expect(w.csps.find((c) => c.route.path === "/app")?.fallback).toBe(true);
    const r = checkExport({ outDir, appDir, hosted: false });
    expect(r.ok).toBe(true);
    expect(r.fallbacks).toEqual(["/app"]);
  });

  it("reports a missing export directory", () => {
    const r = checkExport({ outDir: join(tmpdir(), "weft-no-such-export"), appDir: APP_DIR, hosted: false });
    expect(r.ok).toBe(false);
  });
});
