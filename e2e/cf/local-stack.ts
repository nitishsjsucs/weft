// The local stack for playwright.cf.config.ts's `local` project and the local smoke (track cf7-integrate): `pnpm cf:dev`
// on port 5800 with its state under .scratch/cf7/cf-dev-e2e, started from fresh state every time (the state dir is
// removed first, so the Lobby's day counters, leases and worlds are new and the pool provisions again), a pool of 2,
// and siteverify pointed at the local stub on 5809 (e2e/cf/siteverify-stub.ts).
//
// One thing is prepared before cf:dev starts: the world's vault key. `pnpm cf:snapshot` (without --deploy) seals the
// snapshot with the local key in .scratch/cf-snapshot.local-vault-key, while cf:dev generates a new random
// WEFT_VAULT_KEY for its state dir, so every vault read in a restored world fails ("Authentication failed": the IT
// accounts the new-hire routine creates, among others). cf:dev keeps a value it finds in its secrets file, so this
// writes the snapshot's own local key there (mode 600, never printed) after checking it against the manifest's
// fingerprint. Recorded as a contract request for scripts/cf/dev.ts (.scratch/contract-requests/cf7.md).
//
//   node_modules/.bin/tsx e2e/cf/local-stack.ts [--port 5800] [--dir .scratch/cf7/cf-dev-e2e] [--stub-port 5809] [--real-budget]
//
// A fresh state dir is always a provisioning day: the four full restores (84,412 rows written) leave visitors 5,588 of
// the 90,000-row ceiling, and the Lobby admits a lease only while one more engaged session (2,065 rows) fits, so a whole
// run (about 4,100 rows: the scenarios, the tour and their resets) would close leasing before the visitor spec. Like
// cf4's real-engine suite, the stack therefore lifts KV lobby.provision_rows_ceiling to 150,000 before cf:dev starts
// (visitors then get the normal day's 60,000-row share). `--real-budget` keeps the provisioning-day ceiling; the
// deployed day-1 budget is real (handoff F5: run the deployed checks on UTC day 2).
//
// It needs `pnpm cf:snapshot` and the hosted export (WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter
// @weft/web build) first, and says so when either is missing. Stop it with SIGTERM or SIGINT: cf:dev then stops its
// wrangler process group.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCAL, REPO_ROOT } from "./auth";
import { SITEVERIFY_PATH } from "./siteverify-stub";

const MANIFEST = join(REPO_ROOT, "apps/cf/generated/manifest.json");
const LOCAL_KEY_FILE = join(REPO_ROOT, ".scratch/cf-snapshot.local-vault-key");
const EXPORT_DIR = join(REPO_ROOT, "apps/web/out");

const vaultFingerprint = (keyHex: string): string => "fp_" + createHash("sha256").update("weft-vault-fingerprint:" + keyHex).digest("hex").slice(0, 12);

/** Why the local stack cannot start (null when it can). */
export function prerequisiteProblem(): string | null {
  if (!existsSync(MANIFEST)) return "no snapshot in apps/cf/generated: run pnpm cf:snapshot first";
  if (!existsSync(join(EXPORT_DIR, "index.html")) || !existsSync(join(EXPORT_DIR, "_redirects"))) {
    return "no hosted static export in apps/web/out: run WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build first";
  }
  return null;
}

/** Writes WEFT_VAULT_KEY (the snapshot's local key) into the fresh state dir's secrets file. Prints nothing secret. */
export function seedVaultKey(dir: string): void {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { extra?: { vaultKeyFingerprint?: string } };
  const fp = manifest.extra?.vaultKeyFingerprint ?? "";
  if (!fp.startsWith("local:")) throw new Error("apps/cf/generated holds a deploy-sealed snapshot; rebuild it for local runs with pnpm cf:snapshot (no --deploy)");
  if (!existsSync(LOCAL_KEY_FILE)) throw new Error("the snapshot's local vault key (.scratch/cf-snapshot.local-vault-key) is missing; run pnpm cf:snapshot again");
  const key = readFileSync(LOCAL_KEY_FILE, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(key) || `local:${vaultFingerprint(key)}` !== fp) throw new Error("the local vault key does not match the snapshot's fingerprint; run pnpm cf:snapshot again");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "secrets.env");
  writeFileSync(file, `WEFT_VAULT_KEY=${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The KV namespace id local configs keep (scripts/cf/lib/configs.ts PLACEHOLDER_IDS.kv). */
const LOCAL_KV_ID = "00000000000000000000000000000000";
export const LOCAL_PROVISION_CEILING = 150_000;

/** Writes one KV weft-config key into the local state before wrangler dev opens it (never the remote namespace). */
export function seedLocalKv(dir: string, key: string, value: string): void {
  execFileSync(join(REPO_ROOT, "node_modules/.bin/wrangler"), ["kv", "key", "put", key, value, "--namespace-id", LOCAL_KV_ID, "--local", "--persist-to", join(dir, "state")], {
    cwd: dir, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
}

async function main(argv: string[]): Promise<void> {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  const port = Number(arg("--port") ?? LOCAL.port);
  const stubPort = Number(arg("--stub-port") ?? LOCAL.stubPort);
  const dir = resolve(REPO_ROOT, arg("--dir") ?? LOCAL.dir);
  if (!dir.startsWith(join(REPO_ROOT, ".scratch") + "/")) throw new Error(`--dir must be under .scratch/ (got ${dir})`);
  const problem = prerequisiteProblem();
  if (problem) throw new Error(problem);
  rmSync(dir, { recursive: true, force: true });
  seedVaultKey(dir);
  const lifted = !argv.includes("--real-budget");
  if (lifted) seedLocalKv(dir, "lobby.provision_rows_ceiling", String(LOCAL_PROVISION_CEILING));
  const verifyUrl = `http://localhost:${stubPort}${SITEVERIFY_PATH}`;
  console.log(`cf7 local stack: fresh state in ${dir.replace(REPO_ROOT + "/", "")}, siteverify at ${verifyUrl}, ${lifted ? `provisioning ceiling lifted to ${LOCAL_PROVISION_CEILING.toLocaleString("en-US")} rows` : "provisioning-day budget"}`);
  const child = spawn(join(REPO_ROOT, "node_modules/.bin/tsx"), [
    join(REPO_ROOT, "scripts/cf/dev.ts"), "--port", String(port), "--pool", "2", "--dir", dir, "--turnstile-verify-url", verifyUrl,
  ], { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* gone */ } };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const code = await new Promise<number>((r) => child.on("exit", (c, s) => r(c ?? (s ? 0 : 1))));
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf7 local stack: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
