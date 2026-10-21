// pnpm cf:deploy (docs/cloudflare/design.md 9.2 to 9.5). Run it through scripts/cf/with-cf.sh, which puts the account
// token and id in its environment; the Deploy stage runs it, never a track.
//
//   with-cf.sh pnpm cf:deploy secrets     generate the missing generated secrets into ~/Developer/projects/
//                                         .weft.cf.secrets.env (mode 600, never printed) and install every Worker
//                                         secret with put-secret.sh (names only are printed)
//   with-cf.sh pnpm cf:deploy             deploy the last pnpm cf:build: D1 migrations, weft-core, then weft, then
//                                         KV snapshot.version; it refuses a build with placeholders, without
//                                         resources, with uncommitted changes, with node:fs, node:child_process or
//                                         node:net reachable from weft-core, with a snapshot that has no company
//                                         memory, or sealed with another vault key
//   with-cf.sh pnpm cf:deploy rollback <core version> <front version>
//
// After a deploy the first step is the transaction conformance run (POST /api/_admin/conformance); any failure means
// rolling back both scripts (design 9.2 step 5).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_CONFIG_KEYS } from "../../packages/contracts/src/ext/cf-hosted";
import type { BuildRecord } from "./build";
import { CF_SECRETS_FILE, CF_DIR, ensureEnvValue, readEnvValue, REPO_ROOT, WEFT_SECRETS_FILE, WORKER_SECRETS } from "./lib/env-file";
import { vaultFingerprint } from "./snapshot";

const LAST_BUILD = join(REPO_ROOT, ".scratch/cf-build/last.json");

/** Why a build may not be deployed (empty when it may). */
export function deployRefusals(b: BuildRecord, deployVaultKey: string | null): string[] {
  const out: string[] = [];
  if (b.placeholders.snapshot) out.push("the build used a placeholder snapshot (no cf1-db snapshot code in that commit)");
  if (b.placeholders.web) out.push("the build used placeholder assets (no static export in that commit)");
  if (b.placeholders.resources) out.push("the build has placeholder resource ids (run pnpm cf:resources, then pnpm cf:build)");
  if (b.placeholders.mcp !== false) out.push("the build used the @weft/mcp placeholder (no cf3-agent apps/mcp/src/index.ts in that commit), so no world could boot");
  for (const r of b.importScan?.reachable ?? []) out.push(`the import scan reached ${r.module} from the weft-core entry (design 6.4) via ${r.chain.join(" -> ")}`);
  if (!b.snapshot.memoryHead) out.push("the snapshot has no company memory HEAD (pnpm cf:snapshot refuses that; rebuild with the current scripts)");
  if (b.dirty) out.push("the build was made with uncommitted changes in the checkout");
  if (!deployVaultKey) out.push("WEFT_VAULT_KEY is not in the cf secrets file (pnpm cf:deploy secrets)");
  else if (b.snapshot.vaultKeyFingerprint !== vaultFingerprint(deployVaultKey)) out.push("the snapshot was sealed with another vault key (pnpm cf:build --deploy-snapshot)");
  if (b.sizes.front.uploadKiB >= 1024 || b.sizes.core.uploadKiB >= 16 * 1024) out.push("a bundle is over its size limit");
  return out;
}

function needToken(): void {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("cf:deploy: run it through scripts/cf/with-cf.sh (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set)");
    process.exit(1);
  }
}

const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

function secrets(): void {
  needToken();
  for (const s of WORKER_SECRETS) if (s.source === "generated" && s.make) ensureEnvValue(CF_SECRETS_FILE, s.name, s.make);
  const putSecret = join(CF_DIR, "put-secret.sh");
  for (const s of WORKER_SECRETS) {
    const file = s.source === "weft" ? WEFT_SECRETS_FILE : CF_SECRETS_FILE;
    if (!readEnvValue(file, s.name)) {
      if (s.source === "optional") { console.log(`cf:deploy secrets: ${s.name} not set (optional)`); continue; }
      console.error(`cf:deploy secrets: ${s.name} is missing (${s.source === "resources" ? "pnpm cf:resources writes it" : "add it to the secrets file"})`);
      process.exit(1);
    }
    for (const w of s.workers) {
      const config = join(REPO_ROOT, "apps/cf", w === "weft-core" ? "wrangler.core.jsonc" : "wrangler.front.jsonc");
      execFileSync(putSecret, [s.name, file, s.name, config], { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"], env: process.env });
    }
  }
}

function deploy(argv: string[]): void {
  needToken();
  const i = argv.indexOf("--build");
  const recordFile = i >= 0 ? join(argv[i + 1]!, "apps/cf/dist/build.json") : LAST_BUILD;
  if (!existsSync(recordFile)) { console.error("cf:deploy: no build record; run pnpm cf:build first"); process.exit(1); }
  const b = JSON.parse(readFileSync(recordFile, "utf8")) as BuildRecord;
  const refusals = deployRefusals(b, readEnvValue(CF_SECRETS_FILE, "WEFT_VAULT_KEY"));
  if (refusals.length) { console.error(`cf:deploy: refusing build ${b.sha.slice(0, 12)}:\n  ${refusals.join("\n  ")}`); process.exit(1); }
  const cf = join(b.dir, "apps/cf");
  if (existsSync(join(cf, "d1"))) run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "weft-ops", "--remote", "-c", "wrangler.core.deploy.json"], cf);
  run("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.core.deploy.json"], cf);
  run("pnpm", ["exec", "wrangler", "deploy", "-c", "wrangler.front.deploy.json"], cf);
  if (b.snapshot.id) run("pnpm", ["exec", "wrangler", "kv", "key", "put", HOSTED_CONFIG_KEYS.snapshotVersion, b.snapshot.id, "--binding", "CONFIG", "--remote", "-c", "wrangler.core.deploy.json"], cf);
  console.log(`cf:deploy: deployed ${b.sha.slice(0, 12)} (snapshot ${b.snapshot.id}). Next: POST /api/_admin/conformance, then POST /api/_admin/provision.`);
}

function rollback(argv: string[]): void {
  needToken();
  const [core, front] = argv;
  if (!core || !front) { console.error("usage: pnpm cf:deploy rollback <weft-core version> <weft version>"); process.exit(2); }
  const cf = join(REPO_ROOT, "apps/cf");
  run("pnpm", ["exec", "wrangler", "rollback", front, "--name", "weft", "-y"], cf);
  run("pnpm", ["exec", "wrangler", "rollback", core, "--name", "weft-core", "-y"], cf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "secrets") secrets();
    else if (cmd === "rollback") rollback(rest);
    else deploy(process.argv.slice(2));
  } catch (e) {
    console.error(`cf:deploy: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
