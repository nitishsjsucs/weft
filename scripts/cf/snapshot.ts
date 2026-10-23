// pnpm cf:snapshot (docs/cloudflare/design.md 4.1 and 9.2 step 2): seeds the rich world on Node into
// .scratch/cf-snapshot/ with WEFT_MEMORY=sqlite, WEFT_BLOBS=sqlite, WEFT_CLOCK_RATE=0 and the vault key, boots it once
// (so routine rows match the code) with the seeded API keys revoked (a snapshot holding a live one is refused), takes
// it apart with cf1-db's buildSnapshot (INSERT chunks under 90 KB, per-table seed rows, the manifest of per-table
// counts and digests) and writes, in apps/cf/generated/ (gitignored, private):
//
//   snapshot-rich.sql.gz  the INSERT chunks          seed-rows.json.gz  per-table seed rows for the delta reset
//   manifest.json         cf1's manifest plus extra: the snapshot id, db:digest, the chain head, the memory HEAD,
//                         the vault key's fingerprint and the landing page's stats
//   stats.json            the stats alone (pnpm cf:build puts it in apps/web/public before the web export; pnpm
//                         cf:dev copies it beside the assets it serves)
//
// The build fails when the migrations' journal hash differs from the bundled migrations (apps/cf/generated/
// fixtures.ts). `--deploy` seals the world with the deploy WEFT_VAULT_KEY from the cf secrets file (read with awk,
// never printed); without it a local key under .scratch/ is used and the manifest says so, and pnpm cf:deploy refuses
// such a snapshot.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as weftDb from "../../packages/db/src/index";
import { CF_SECRETS_FILE, hex, readEnvValue, REPO_ROOT } from "./lib/env-file";
import { LOCAL_FINGERPRINT_PREFIX, LOCAL_VAULT_KEY_FILE as LOCAL_KEY_FILE, vaultFingerprint } from "./lib/vault-key";
import { FIXTURE_FILES } from "../../apps/cf/generated/fixtures";

export const OUT_DIR = join(REPO_ROOT, "apps/cf/generated");
export const DATA_DIR = join(REPO_ROOT, ".scratch/cf-snapshot");
export { LOCAL_FINGERPRINT_PREFIX, vaultFingerprint };

export const snapshotId = (digest: string, journalHash: string): string => createHash("sha256").update(`${digest}|${journalHash}`).digest("hex").slice(0, 16);

type Db = Record<string, unknown>;
const need = <T>(name: string): T => {
  const v = (weftDb as Db)[name];
  if (v === undefined) throw new Error(`cf1-db: @weft/db does not export ${name} yet; pnpm cf:snapshot needs cf1-db's snapshot.ts`);
  return v as T;
};

/** The journal hash of the bundled migrations, which the Worker restores under. */
export function bundledJournalHash(files: Readonly<Record<string, string>> = FIXTURE_FILES): string {
  const migrationEntries = need<(j: unknown, t: (tag: string) => string) => unknown[]>("migrationEntries");
  const journalHash = need<(e: unknown[]) => string>("journalHash");
  const journal = files["packages/db/drizzle/meta/_journal.json"];
  if (!journal) throw new Error("the bundled fixtures have no migration journal; run pnpm cf:fixtures");
  return journalHash(migrationEntries(JSON.parse(journal), (tag) => {
    const t = files[`packages/db/drizzle/${tag}.sql`];
    if (t === undefined) throw new Error(`the bundled fixtures have no ${tag}.sql; run pnpm cf:fixtures`);
    return t;
  }));
}

function vaultKey(deploy: boolean): { key: string; fingerprint: string } {
  if (deploy) {
    const key = readEnvValue(CF_SECRETS_FILE, "WEFT_VAULT_KEY");
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) throw new Error("--deploy needs WEFT_VAULT_KEY (64 hex) in the cf secrets file; pnpm cf:deploy secrets generates it");
    return { key, fingerprint: vaultFingerprint(key) };
  }
  mkdirSync(join(REPO_ROOT, ".scratch"), { recursive: true });
  if (!existsSync(LOCAL_KEY_FILE)) writeFileSync(LOCAL_KEY_FILE, hex(32) + "\n", { mode: 0o600 });
  chmodSync(LOCAL_KEY_FILE, 0o600);
  const key = readFileSync(LOCAL_KEY_FILE, "utf8").trim();
  return { key, fingerprint: LOCAL_FINGERPRINT_PREFIX + vaultFingerprint(key) };
}

/** What scripts/cf/lib/snapshot-boot.ts prints. */
export interface BootedWorld { worldDigest: string; chainHead: string | null; memoryHead: string | null; memory?: { objects: number; commits: number; refs: number }; stats: unknown }

/**
 * Why the booted world cannot ship (null when it can): every world restores the company memory from the snapshot
 * (the seed's files and commits in mem_objects, mem_refs and mem_log), so a snapshot without a memory HEAD or with an
 * empty SQL repo would deploy worlds with no memory. WEFT_MEMORY=sqlite has to reach the SQL repo on Node.
 */
export function snapshotMemoryProblem(b: Pick<BootedWorld, "memoryHead" | "memory">): string | null {
  const m = b.memory ?? { objects: 0, commits: 0, refs: 0 };
  if (b.memoryHead && m.objects > 0 && m.commits > 0) return null;
  return `the seeded world has no company memory in SQL (memory HEAD ${b.memoryHead ?? "none"}, mem_objects ${m.objects}, mem_log ${m.commits}, mem_refs ${m.refs}): `
    + "WEFT_MEMORY=sqlite did not reach the SQL memory repo (createExecutor's memory options, contract request cf2 item 6), so the snapshot is refused";
}

/** A snapshot's seed rows as far as the key check reads them (cf1's SeedRows). */
export type SeedRowsLike = Record<string, { columns: string[]; rowid: boolean; rows: unknown[][] }>;

/**
 * The ids of API keys a snapshot would restore unrevoked. The seed mints an admin and an MCP key whose plaintexts sit
 * in the Node data dir; every world restored from the snapshot would accept them, so snapshot-boot.ts revokes them
 * and the build refuses a snapshot that still holds a live one. A hosted world's keys are minted per lease.
 */
export function unrevokedSeedKeys(seed: SeedRowsLike): string[] {
  const t = seed.api_keys;
  if (!t) return [];
  const id = t.columns.indexOf("id");
  const revoked = t.columns.indexOf("revoked_at");
  if (id < 0 || revoked < 0) throw new Error("snapshot: api_keys has no id or revoked_at column");
  const off = t.rowid ? 1 : 0;   // the rowid leads each row when it is not a column
  return t.rows.filter((r) => r[off + revoked] === null || r[off + revoked] === undefined).map((r) => String(r[off + id]));
}

/** cf1-db's exports this script needs; `--check-deps` exits 3 when one is missing (pnpm cf:build reads it). */
export const SNAPSHOT_DEPS = ["openDurableEmulator", "buildSnapshot", "encodeSnapshot", "readMigrationsFromDir", "journalHash", "migrationEntries"] as const;
export const missingSnapshotDeps = (): string[] => SNAPSHOT_DEPS.filter((n) => (weftDb as Db)[n] === undefined);

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--check-deps")) {
    const missing = missingSnapshotDeps();
    if (missing.length) { console.log(`cf:snapshot: cf1-db does not export ${missing.join(", ")} yet`); process.exit(3); }
    console.log("cf:snapshot: cf1-db's snapshot exports are present");
    return;
  }
  const deploy = argv.includes("--deploy");
  // Fail before seeding when cf1's snapshot code is not here.
  const openDurableEmulator = need<(o: { path: string }) => unknown>("openDurableEmulator");
  const buildSnapshot = need<(s: unknown, o: { journalHash: string }) => { manifest: { digest: string; chunks: number; rows: number; journalHash: string; extra?: Record<string, unknown> }; seed: SeedRowsLike }>("buildSnapshot");
  const encodeSnapshot = need<(s: unknown) => Promise<{ chunks: Uint8Array; seed: Uint8Array; manifest: string }>>("encodeSnapshot");
  const readMigrationsFromDir = need<(dir: string) => unknown[]>("readMigrationsFromDir");
  const journalHash = need<(e: unknown[]) => string>("journalHash");

  const repoJournal = journalHash(readMigrationsFromDir(join(REPO_ROOT, "packages/db/drizzle")));
  const bundled = bundledJournalHash();
  if (repoJournal !== bundled) throw new Error("the bundled migrations differ from packages/db/drizzle (journal hash); run pnpm cf:fixtures");

  const { key, fingerprint } = vaultKey(deploy);
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  // WEFT_PREBUILT_HASH=1: the boot stores the prebuilt routines' hash in kv_state, so a restored world's first GET
  // /v1/routines (and its first tick) compares nothing and writes no row (design 4.4; cf2 contract request 4).
  const env = {
    ...process.env, WEFT_DATA_DIR: DATA_DIR, WEFT_SEED_PROFILE: "rich", WEFT_MEMORY: "sqlite", WEFT_BLOBS: "sqlite", WEFT_CLOCK_RATE: "0",
    WEFT_VAULT_KEY: key, WEFT_REQUIRE_VAULT_KEY: "1", WEFT_LLM: "scripted", WEFT_EPHEMERAL_READ_IDS: "1", WEFT_PREBUILT_HASH: "1",
  };
  const tsx = join(REPO_ROOT, "node_modules/.bin/tsx");
  const run = (args: string[]) => execFileSync(tsx, args, { cwd: REPO_ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 });
  const t0 = Date.now();
  run(["packages/seed/src/cli.ts", "reset"]);
  run(["packages/seed/src/cli.ts", "seed"]);
  const booted = JSON.parse(run(["scripts/cf/lib/snapshot-boot.ts"]).trim().split("\n").at(-1)!) as BootedWorld;
  const memoryProblem = snapshotMemoryProblem(booted);
  if (memoryProblem) throw new Error(memoryProblem);

  const storage = openDurableEmulator({ path: join(DATA_DIR, "weft.db") });
  const snap = buildSnapshot(storage, { journalHash: bundled });
  const live = unrevokedSeedKeys(snap.seed);
  if (live.length) throw new Error(`the snapshot would restore API keys that are not revoked (${live.join(", ")}); every world would accept them`);
  // Their plaintexts are of no use now; they do not stay beside the seeded world either.
  for (const f of readdirSync(DATA_DIR)) if (/^demo-.*key\.txt$/.test(f)) rmSync(join(DATA_DIR, f), { force: true });
  const id = snapshotId(snap.manifest.digest, bundled);
  snap.manifest.extra = {
    snapshotId: id, createdAt: new Date().toISOString(), profile: "rich", worldDigest: booted.worldDigest, chainHead: booted.chainHead,
    memoryHead: booted.memoryHead, vaultKeyFingerprint: fingerprint, stats: booted.stats,
  };
  const files = await encodeSnapshot(snap);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "snapshot-rich.sql.gz"), files.chunks);
  writeFileSync(join(OUT_DIR, "seed-rows.json.gz"), files.seed);
  writeFileSync(join(OUT_DIR, "manifest.json"), files.manifest + "\n");
  writeFileSync(join(OUT_DIR, "stats.json"), JSON.stringify(booted.stats, null, 2) + "\n");
  const kib = (b: Uint8Array) => (b.byteLength / 1024).toFixed(1);
  console.log(`cf:snapshot ${id}: ${snap.manifest.chunks} chunks, ${snap.manifest.rows} rows, chunks ${kib(files.chunks)} KiB gz, seed rows ${kib(files.seed)} KiB gz, ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`  world digest ${booted.worldDigest.slice(0, 12)}..., chain head ${booted.chainHead?.slice(0, 12) ?? "none"}..., memory HEAD ${booted.memoryHead?.slice(0, 12) ?? "none"} (${booted.memory?.objects ?? 0} objects, ${booted.memory?.commits ?? 0} commits), vault ${fingerprint}${deploy ? "" : " (local key: not deployable)"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`cf:snapshot: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
