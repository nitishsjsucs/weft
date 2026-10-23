// pnpm cf:build (docs/cloudflare/design.md 9.2 step 3): builds what pnpm cf:deploy ships, in a throwaway git worktree
// of the deploy commit (only committed code ships; the main checkout, its dev server on ports 3070 and 4070 and .data
// are never touched):
//
//   1. git worktree add --detach <build dir> HEAD; pnpm install --frozen-lockfile
//   2. the fixtures module is fresh (pnpm cf:fixtures --check)
//   3. the snapshot (pnpm cf:snapshot, `--deploy` sealed with the deploy vault key), or `--snapshot-from <dir>`
//   4. apps/cf/resources.json (pnpm cf:resources), read before the web build: it holds the weft widget's sitekey
//   5. the web export: the snapshot's stats.json into apps/web/public (the landing's HTML carries its numbers), then
//      WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build with
//      NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY from the resources and WEFT_PUBLIC_ORIGIN from weft-core's config (the CSP's
//      wss origin); an export that still carries Turnstile's always-pass test sitekey is a placeholder
//   6. the deploy configs rendered from the resources (placeholders before pnpm cf:resources)
//   7. wrangler deploy --dry-run for both configs: the size and binding check (front under 1 MiB, core under 16 MiB),
//      and the import scan of weft-core (design 6.4: it fails when node:fs, node:child_process or node:net is
//      reachable from the entry)
//
// A commit without cf1-db's snapshot code, cf3-agent's @weft/mcp entry or cf5-web's static export still bundles: the
// missing part is replaced by a placeholder, said so loudly, and recorded in the build record. Such a build, a build
// without resources (its export has the test sitekey), a failed import scan and a snapshot without company memory
// are not deployable, and pnpm cf:deploy refuses them. Without resources the build still succeeds, as a dry run.
// Output: <build dir>/apps/cf/dist/build.json, and .scratch/cf-build/last.json in this checkout pointing at it.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { deployConfigs, readResources, readWranglerConfig, usesMcpPlaceholder, writeDeployConfigs, type CfResources } from "./lib/configs";
import { REPO_ROOT } from "./lib/env-file";
import { scanImports, type Metafile } from "./lib/import-scan";

export const LIMITS = { frontKiB: 1024, coreKiB: 16 * 1024 } as const;
const LOG_DIR = join(REPO_ROOT, ".scratch/cf-build");
/** Cloudflare's published always-pass Turnstile sitekey. The hosted shell falls back to it when the build sets no
 * NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY (apps/web/src/lib/hosted/flags.ts); the deployed widget's secret rejects its
 * tokens, so an export that carries it would refuse every lease. */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";
/** The deployed origin, when weft-core's config names none. */
export const DEPLOY_ORIGIN = "https://weft.nitish-ratakonda.workers.dev";

export interface BuildRecord {
  sha: string;
  dirty: boolean;
  dir: string;
  createdAt: string;
  /** mcp: @weft/mcp was the placeholder (cf3-agent not merged), so the real engine cannot boot. sitekey: the web export
   * carries Turnstile's always-pass test sitekey (no resources), so the deployed site would refuse every lease. */
  placeholders: { snapshot: boolean; web: boolean; resources: boolean; mcp: boolean; sitekey: boolean };
  sizes: Record<"core" | "front", { uploadKiB: number; gzipKiB: number }>;
  importScan: { reachable: { module: string; chain: string[] }[]; inputs: number };
  snapshot: { id: string | null; vaultKeyFingerprint: string | null; memoryHead: string | null };
  deployable: boolean;
}

/** "Total Upload: 7027.79 KiB / gzip: 1429.41 KiB" from wrangler's dry-run output. */
export function parseUploadSize(out: string): { uploadKiB: number; gzipKiB: number } | null {
  const m = /Total Upload:\s*([\d.]+)\s*(KiB|MiB)\s*\/\s*gzip:\s*([\d.]+)\s*(KiB|MiB)/.exec(out);
  if (!m) return null;
  const kib = (n: string, u: string) => Number(n) * (u === "MiB" ? 1024 : 1);
  return { uploadKiB: kib(m[1]!, m[2]!), gzipKiB: kib(m[3]!, m[4]!) };
}

/** A build may ship only with no placeholder, its sizes under the limits, a clean import scan, a snapshot with company
 * memory, and no uncommitted changes (pnpm cf:deploy checks the same through deployRefusals). */
export function buildDeployable(b: Pick<BuildRecord, "placeholders" | "sizes" | "importScan" | "snapshot" | "dirty">): boolean {
  const p = b.placeholders;
  return !p.snapshot && !p.web && !p.resources && !p.mcp && p.sitekey === false && sizeProblems(b.sizes).length === 0 && b.importScan.reachable.length === 0 && !!b.snapshot.memoryHead && !b.dirty;
}

export function sizeProblems(sizes: BuildRecord["sizes"]): string[] {
  const out: string[] = [];
  if (sizes.front.uploadKiB >= LIMITS.frontKiB) out.push(`front ${sizes.front.uploadKiB.toFixed(0)} KiB is not under 1 MiB`);
  if (sizes.core.uploadKiB >= LIMITS.coreKiB) out.push(`core ${sizes.core.uploadKiB.toFixed(0)} KiB is not under 16 MiB`);
  return out;
}

/** The web export's build environment: the hosted switches, the deployed origin (the CSP's wss origin) and, with
 * resources, the weft widget's sitekey. Without resources no sitekey is passed, so the export falls back to the test
 * sitekey and the build is a dry run (the sitekey placeholder). */
export function webBuildEnv(base: NodeJS.ProcessEnv, o: { resources: CfResources | null; publicOrigin: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, WEFT_STATIC_EXPORT: "1", NEXT_PUBLIC_WEFT_HOSTED: "1", WEFT_PUBLIC_ORIGIN: o.publicOrigin };
  if (o.resources) env.NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY = o.resources.turnstile.sitekey;
  else delete env.NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY;   // the sitekey comes from apps/cf/resources.json only
  return env;
}

const TEXT_EXPORT_FILES = new Set([".html", ".js", ".mjs", ".txt", ".json", ".css"]);
/** The export's files (relative paths) that carry the always-pass test sitekey. */
export function filesWithTestSitekey(outDir: string): string[] {
  const hits: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(outDir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (TEXT_EXPORT_FILES.has(extname(e.name)) && readFileSync(join(outDir, p), "utf8").includes(TURNSTILE_TEST_SITEKEY)) hits.push(p);
    }
  };
  if (existsSync(outDir)) walk("");
  return hits.sort();
}

function sh(cmd: string, args: string[], o: ExecFileSyncOptions & { log: string; quiet?: boolean }): string {
  try {
    const out = execFileSync(cmd, args, { ...o, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 }) as string;
    writeFileSync(o.log, `$ ${cmd} ${args.join(" ")}\n${out}\n`, { flag: "a" });
    return out;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    writeFileSync(o.log, `$ ${cmd} ${args.join(" ")}\n${err.stdout ?? ""}\n${err.stderr ?? ""}\n`, { flag: "a" });
    throw Object.assign(new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed (exit ${err.status ?? "?"}); see ${o.log}`), { status: err.status, stdout: err.stdout ?? "" });
  }
}

async function main(argv: string[]): Promise<void> {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
  const sha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim().length > 0;
  const root = arg("--dir") ?? process.env.WEFT_CF_BUILD_DIR ?? join(tmpdir(), "weft-cf-build");
  const dir = join(root, sha.slice(0, 12));
  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `${sha.slice(0, 12)}.log`);
  writeFileSync(log, `cf:build ${sha} ${new Date().toISOString()}\n`);
  const say = (l: string) => console.log(`cf:build: ${l}`);
  say(`commit ${sha.slice(0, 12)}${dirty ? " (uncommitted changes in this checkout do not ship)" : ""}; log ${log.replace(REPO_ROOT + "/", "")}`);

  // 1. Throwaway worktree of the commit.
  if (existsSync(dir)) {
    try { sh("git", ["-C", REPO_ROOT, "worktree", "remove", "--force", dir], { log }); } catch { rmSync(dir, { recursive: true, force: true }); }
  }
  sh("git", ["-C", REPO_ROOT, "worktree", "add", "--detach", dir, sha], { log });
  say(`worktree ${dir}`);
  sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: dir, log });
  const tsx = join(dir, "node_modules/.bin/tsx");

  // 2. Fixtures fresh.
  sh(tsx, ["scripts/cf/fixtures.ts", "--check"], { cwd: dir, log });
  say("fixtures module is fresh");

  // 3. Snapshot.
  let placeholderSnapshot = false;
  const gen = join(dir, "apps/cf/generated");
  const from = arg("--snapshot-from");
  if (from) {
    for (const f of ["snapshot-rich.sql.gz", "seed-rows.json.gz", "manifest.json", "stats.json"]) copyFileSync(join(from, f), join(gen, f));
    say(`snapshot copied from ${from}`);
  } else {
    let haveDeps = true;
    try { sh(tsx, ["scripts/cf/snapshot.ts", "--check-deps"], { cwd: dir, log }); } catch (e) { if ((e as { status?: number }).status === 3) haveDeps = false; else throw e; }
    if (haveDeps) {
      sh(tsx, ["scripts/cf/snapshot.ts", ...(argv.includes("--deploy-snapshot") ? ["--deploy"] : [])], { cwd: dir, log });
      say("snapshot built");
    } else {
      placeholderSnapshot = true;
      const { gzipSync } = await import("node:zlib");
      writeFileSync(join(gen, "snapshot-rich.sql.gz"), gzipSync("[]"));
      writeFileSync(join(gen, "seed-rows.json.gz"), gzipSync("{}"));
      writeFileSync(join(gen, "manifest.json"), JSON.stringify({ placeholder: true, version: 0, journalHash: "", digest: "placeholder", chunks: 0, rows: 0 }) + "\n");
      writeFileSync(join(gen, "stats.json"), "{}\n");
      say("PLACEHOLDER snapshot: this commit has no cf1-db snapshot code (not deployable)");
    }
  }

  // 4. Resources, before the web build: the export inlines the widget's sitekey.
  const resourcesFile = join(REPO_ROOT, "apps/cf/resources.json");
  if (existsSync(resourcesFile)) copyFileSync(resourcesFile, join(dir, "apps/cf/resources.json"));
  const resources = readResources(join(dir, "apps/cf/resources.json"));
  if (!resources) say("resource ids are placeholders (run pnpm cf:resources before pnpm cf:deploy)");

  // 5. Web export: the snapshot's stats in public/ (Next copies them into the export, and the landing's HTML is built
  // from them), the widget's sitekey and the deployed origin.
  let placeholderWeb = false;
  const publicOrigin = String((readWranglerConfig("core", join(dir, "apps/cf")).vars as Record<string, string> | undefined)?.WEFT_PUBLIC_ORIGIN ?? DEPLOY_ORIGIN).replace(/\/$/, "");
  mkdirSync(join(dir, "apps/web/public"), { recursive: true });
  copyFileSync(join(gen, "stats.json"), join(dir, "apps/web/public/stats.json"));
  sh("pnpm", ["--filter", "@weft/web", "build"], { cwd: dir, log, env: webBuildEnv(process.env, { resources, publicOrigin }) });
  const out = join(dir, "apps/web/out");
  let assetsDir: string | undefined;
  let testSitekeyFiles: string[] = [];
  if (existsSync(join(out, "index.html"))) {
    if (!existsSync(join(out, "stats.json"))) copyFileSync(join(gen, "stats.json"), join(out, "stats.json"));
    testSitekeyFiles = filesWithTestSitekey(out);
    say(`web export built for ${publicOrigin}`);
    if (testSitekeyFiles.length) say(`PLACEHOLDER sitekey: the export carries Turnstile's always-pass test sitekey (${testSitekeyFiles.slice(0, 3).join(", ")}${testSitekeyFiles.length > 3 ? ", ..." : ""}); ${resources ? "the resources' sitekey did not reach it" : "no apps/cf/resources.json"} (not deployable)`);
  } else {
    placeholderWeb = true;
    assetsDir = join(dir, "apps/cf/dist/placeholder-assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>Weft</title><p>Placeholder: this commit has no static export.</p>\n");
    say("PLACEHOLDER assets: this commit's web build emits no static export (cf5-web), not deployable");
  }

  // 6. Deploy configs.
  const cfgs = deployConfigs({ resources, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null, assetsDir, appsCf: join(dir, "apps/cf") });
  const paths = writeDeployConfigs(cfgs, "deploy", join(dir, "apps/cf"));
  const placeholderMcp = usesMcpPlaceholder(cfgs.core);
  if (placeholderMcp) say("PLACEHOLDER @weft/mcp: this commit has no cf3-agent apps/mcp/src/index.ts, so the real engine cannot boot (not deployable)");

  // 7. Dry runs and the import scan.
  const sizes = {} as BuildRecord["sizes"];
  let scan: BuildRecord["importScan"] = { reachable: [], inputs: 0 };
  for (const name of ["core", "front"] as const) {
    const meta = join(dir, `apps/cf/dist/${name}.meta.json`);
    const o = sh("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", `dist/${name}`, "--metafile", meta, "-c", paths[name]], { cwd: join(dir, "apps/cf"), log });
    const size = parseUploadSize(o);
    if (!size) throw new Error(`could not read the ${name} bundle size from wrangler's output; see ${log}`);
    sizes[name] = size;
    if (name === "core") {
      const r = scanImports(JSON.parse(readFileSync(meta, "utf8")) as Metafile, (p) => p.endsWith("src/core/index.ts"));
      scan = { reachable: r.reachable, inputs: r.inputs };
    }
  }
  const problems = sizeProblems(sizes);
  const manifest = JSON.parse(readFileSync(join(gen, "manifest.json"), "utf8")) as { extra?: { snapshotId?: string; vaultKeyFingerprint?: string; memoryHead?: string | null } };
  const placeholders = { snapshot: placeholderSnapshot, web: placeholderWeb, resources: !resources, mcp: placeholderMcp, sitekey: testSitekeyFiles.length > 0 };
  const snapshot = { id: manifest.extra?.snapshotId ?? null, vaultKeyFingerprint: manifest.extra?.vaultKeyFingerprint ?? null, memoryHead: manifest.extra?.memoryHead ?? null };
  const record: BuildRecord = {
    sha, dirty, dir, createdAt: new Date().toISOString(), placeholders, sizes, importScan: scan, snapshot,
    deployable: buildDeployable({ placeholders, sizes, importScan: scan, snapshot, dirty }),
  };
  writeFileSync(join(dir, "apps/cf/dist/build.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(LOG_DIR, "last.json"), JSON.stringify(record, null, 2) + "\n");

  say(`weft-core: ${sizes.core.uploadKiB.toFixed(1)} KiB, gzip ${sizes.core.gzipKiB.toFixed(1)} KiB (limit 16 MiB)`);
  say(`weft:      ${sizes.front.uploadKiB.toFixed(1)} KiB, gzip ${sizes.front.gzipKiB.toFixed(1)} KiB (limit 1 MiB)`);
  say(scan.reachable.length
    ? `import scan FAILED (design 6.4): ${scan.reachable.map((r) => `${r.module} via ${r.chain.join(" -> ")}`).join("; ")} (${scan.inputs} modules)`
    : `import scan: no node:fs, node:child_process or node:net (${scan.inputs} modules)`);
  say(`wrangler deploy --dry-run succeeded for both configs; ${record.deployable ? "deployable" : "not deployable (placeholders, resources, the test sitekey, size, the import scan, no memory HEAD or uncommitted changes)"}`);
  if (problems.length) {
    console.error(`cf:build: ${problems.join("; ")}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:build: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
