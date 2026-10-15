// Scaffold (frozen): `pnpm db:seed`, `pnpm db:reset`, `pnpm db:digest`. Data dir: $WEFT_DATA_DIR (default .data).
// createWeft lives in apps/api; it is loaded by path so @weft/seed does not depend on @weft/api (which depends on it).
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDb, migrate, openDb } from "@weft/db";
import { digestDb, seedWorld, type SeedTarget } from "./index";

type CreateWeft = (opts: { dataDir: string; testMode?: boolean; seeding?: boolean }) => Promise<SeedTarget & { close(): Promise<void> }>;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataDir = resolve(process.env.WEFT_DATA_DIR ?? join(repoRoot, ".data"));

async function loadCreateWeft(): Promise<CreateWeft> {
  const mod = (await import(pathToFileURL(join(repoRoot, "apps/api/src/compose.ts")).href)) as { createWeft: CreateWeft };
  return mod.createWeft;
}

export function resetData(dir: string): void {
  for (const f of ["weft.db", "weft.db-wal", "weft.db-shm"]) rmSync(join(dir, f), { force: true });
  rmSync(join(dir, "companies"), { recursive: true, force: true });   // memory repos and run workspaces; never .data/spend
}

async function main(cmd: string | undefined): Promise<void> {
  if (cmd === "reset") {
    resetData(dataDir);
    const db = openDb({ dataDir });
    try { await migrate(db); } finally { await closeDb(db); }
    console.log(`reset ${dataDir}`);
  } else if (cmd === "seed") {
    const weft = await (await loadCreateWeft())({ dataDir, seeding: true });
    try { await seedWorld(weft, { log: (l) => console.log(l) }); } finally { await weft.close(); }
  } else if (cmd === "digest") {
    if (!existsSync(join(dataDir, "weft.db"))) throw new Error(`no database at ${dataDir}/weft.db; run pnpm db:reset && pnpm db:seed`);
    const db = openDb({ dataDir });
    try { console.log(await digestDb(db)); } finally { await closeDb(db); }
  } else {
    console.error("usage: cli.ts seed | reset | digest");
    process.exitCode = 2;
  }
}

await main(process.argv[2]);
