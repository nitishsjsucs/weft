// The world identity the spend ledger keys runs by. Agent run ids restart at run_0001 every time the world is rebuilt:
// POST /v1/sim/reset, pnpm db:reset and every eval trial world (the suite keeps only <dataDir>/spend between trials).
// The ledger in <dataDir>/spend outlives all of them, so a run id alone summed the first run of every world into one
// per-run cap. The id lives in <dataDir>/companies/.world-id, beside the memory repos: every path that rebuilds the
// world removes that folder (the reset route, the seed CLI's reset, the eval runner's fresh trial dir), and an API
// restart on the same world keeps it, so a waiting run that resumes after a restart still counts what it spent before.
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

const WORLD_ID = /^wld_[0-9a-f]{16}$/;

export const worldIdFile = (dataDir: string) => join(dataDir, "companies", ".world-id");

function readId(file: string): string | null {
  try {
    const v = fs().readFileSync(file, "utf8").trim();
    return WORLD_ID.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The current world's id, minted on first use. Null only when the file can be neither read nor written: the ledger
 * then keys runs by id alone, the stricter rule it had before.
 */
export function worldId(dataDir: string): string | null {
  const file = worldIdFile(dataDir);
  const known = readId(file);
  if (known) return known;
  const id = `wld_${randomBytes(8).toString("hex")}`;
  try {
    fs().mkdirSync(dirname(file), { recursive: true });
    fs().writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readId(file);
      if (raced) return raced;
      // A file that holds no valid id is not a world anyone keyed spend by: replace it.
      try { fs().writeFileSync(file, `${id}\n`, { mode: 0o600 }); return id; } catch { return null; }
    }
    return null;
  }
}
