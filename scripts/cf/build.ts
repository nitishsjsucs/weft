// pnpm cf:build (docs/cloudflare/design.md 9.2 step 3): builds what pnpm cf:deploy ships, in a throwaway git worktree
// of the deploy commit (only committed code ships; the main checkout, its dev server on ports 3070 and 4070 and .data
// are never touched):
//
//   1. git worktree add --detach <build dir> HEAD; pnpm install --frozen-lockfile
//   2. the fixtures module is fresh (pnpm cf:fixtures --check)
//   3. the snapshot (pnpm cf:snapshot, `--deploy` sealed with the deploy vault key), or `--snapshot-from <dir>`
//   4. WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build; stats.json into the export
//   5. the deploy configs rendered from apps/cf/resources.json (placeholders before pnpm cf:resources)
//   6. wrangler deploy --dry-run for both configs: the size and binding check (front under 1 MiB, core under 16 MiB),
//      and the import scan of weft-core (node:fs, node:child_process, node:net reachable from the entry)
//
// A commit without cf1-db's snapshot code or cf5-web's static export still bundles: the missing part is replaced by
// a placeholder, said so loudly, and recorded in the build record, and pnpm cf:deploy refuses such a build.
// Output: <build dir>/apps/cf/dist/build.json, and .scratch/cf-build/last.json in this checkout pointing at it.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployConfigs, readResources, writeDeployConfigs } from "./lib/configs";
import { REPO_ROOT } from "./lib/env-file";
import { scanImports, type Metafile } from "./lib/import-scan";

export const LIMITS = { frontKiB: 1024, coreKiB: 16 * 1024 } as const;
const LOG_DIR = join(REPO_ROOT, ".scratch/cf-build");

export interface BuildRecord {
  sha: string;
  dirty: boolean;
  dir: string;
  createdAt: string;
  placeholders: { snapshot: boolean; web: boolean; resources: boolean };
  sizes: Record<"core" | "front", { uploadKiB: number; gzipKiB: number }>;
  importScan: { reachable: { module: string; chain: string[] }[]; inputs: number };
  snapshot: { id: string | null; vaultKeyFingerprint: string | null };
  deployable: boolean;
}

/** "Total Upload: 7027.79 KiB / gzip: 1429.41 KiB" from wrangler's dry-run output. */
export function parseUploadSize(out: string): { uploadKiB: number; gzipKiB: number } | null {
  const m = /Total Upload:\s*([\d.]+)\s*(KiB|MiB)\s*\/\s*gzip:\s*([\d.]+)\s*(KiB|MiB)/.exec(out);
  if (!m) return null;
  const kib = (n: string, u: string) => Number(n) * (u === "MiB" ? 1024 : 1);
  return { uploadKiB: kib(m[1]!, m[2]!), gzipKiB: kib(m[3]!, m[4]!) };
}

export function sizeProblems(sizes: BuildRecord["sizes"]): string[] {
  const out: string[] = [];
  if (sizes.front.uploadKiB >= LIMITS.frontKiB) out.push(`front ${sizes.front.uploadKiB.toFixed(0)} KiB is not under 1 MiB`);
  if (sizes.core.uploadKiB >= LIMITS.coreKiB) out.push(`core ${sizes.core.uploadKiB.toFixed(0)} KiB is not under 16 MiB`);
  return out;
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

  // 4. Web export.
  let placeholderWeb = false;
  sh("pnpm", ["--filter", "@weft/web", "build"], { cwd: dir, log, env: { ...process.env, WEFT_STATIC_EXPORT: "1", NEXT_PUBLIC_WEFT_HOSTED: "1" } });
  const out = join(dir, "apps/web/out");
  let assetsDir: string | undefined;
  if (existsSync(join(out, "index.html"))) {
    copyFileSync(join(gen, "stats.json"), join(out, "stats.json"));
    say("web export built");
  } else {
    placeholderWeb = true;
    assetsDir = join(dir, "apps/cf/dist/placeholder-assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>Weft</title><p>Placeholder: this commit has no static export.</p>\n");
    say("PLACEHOLDER assets: this commit's web build emits no static export (cf5-web), not deployable");
  }

  // 5. Deploy configs.
  const resourcesFile = join(REPO_ROOT, "apps/cf/resources.json");
  if (existsSync(resourcesFile)) copyFileSync(resourcesFile, join(dir, "apps/cf/resources.json"));
  const resources = readResources(join(dir, "apps/cf/resources.json"));
  const cfgs = deployConfigs({ resources, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null, assetsDir, appsCf: join(dir, "apps/cf") });
  const paths = writeDeployConfigs(cfgs, "deploy", join(dir, "apps/cf"));
  if (!resources) say("resource ids are placeholders (run pnpm cf:resources before pnpm cf:deploy)");

  // 6. Dry runs and the import scan.
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
  const manifest = JSON.parse(readFileSync(join(gen, "manifest.json"), "utf8")) as { extra?: { snapshotId?: string; vaultKeyFingerprint?: string } };
  const record: BuildRecord = {
    sha, dirty, dir, createdAt: new Date().toISOString(),
    placeholders: { snapshot: placeholderSnapshot, web: placeholderWeb, resources: !resources },
    sizes, importScan: scan,
    snapshot: { id: manifest.extra?.snapshotId ?? null, vaultKeyFingerprint: manifest.extra?.vaultKeyFingerprint ?? null },
    deployable: !placeholderSnapshot && !placeholderWeb && !!resources && problems.length === 0 && !dirty,
  };
  writeFileSync(join(dir, "apps/cf/dist/build.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(LOG_DIR, "last.json"), JSON.stringify(record, null, 2) + "\n");

  say(`weft-core: ${sizes.core.uploadKiB.toFixed(1)} KiB, gzip ${sizes.core.gzipKiB.toFixed(1)} KiB (limit 16 MiB)`);
  say(`weft:      ${sizes.front.uploadKiB.toFixed(1)} KiB, gzip ${sizes.front.gzipKiB.toFixed(1)} KiB (limit 1 MiB)`);
  say(`import scan: ${scan.reachable.length ? scan.reachable.map((r) => `${r.module} via ${r.chain.at(-1)}`).join("; ") : "no node:fs, node:child_process or node:net"} (${scan.inputs} modules)`);
  say(`wrangler deploy --dry-run succeeded for both configs; ${record.deployable ? "deployable" : "not deployable (placeholders, resources, size or uncommitted changes)"}`);
  if (problems.length) {
    console.error(`cf:build: ${problems.join("; ")}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:build: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
