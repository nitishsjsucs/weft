// The import scan of weft-core's bundle (design 6.4) in one call: `wrangler deploy --dry-run` with an esbuild
// metafile, then scanImports from the entry. The bundle imports the snapshot files (src/core/company/
// snapshot-assets.ts), which only pnpm cf:snapshot writes; where they are missing, empty stand-ins are written for the
// dry run and removed afterwards, so the scan never needs a snapshot (the stand-ins change no import).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { APPS_CF } from "./configs";
import { scanImports, type Metafile, type ScanResult } from "./import-scan";

/** The snapshot files the core bundle imports, with the empty stand-in each gets when it is missing. */
export const SNAPSHOT_STAND_INS: Readonly<Record<string, () => Uint8Array | string>> = {
  "snapshot-rich.sql.gz": () => gzipSync("[]"),
  "seed-rows.json.gz": () => gzipSync("{}"),
  "manifest.json": () => "{}\n",
};

/** Runs `fn` with every snapshot file present in `generatedDir`, writing stand-ins for the missing ones and removing
 * only those afterwards. */
export function withSnapshotStandIns<T>(generatedDir: string, fn: () => T): T {
  mkdirSync(generatedDir, { recursive: true });
  const written: string[] = [];
  try {
    for (const [name, make] of Object.entries(SNAPSHOT_STAND_INS)) {
      const file = join(generatedDir, name);
      if (existsSync(file)) continue;
      writeFileSync(file, make());
      written.push(file);
    }
    return fn();
  } finally {
    for (const f of written) rmSync(f, { force: true });
  }
}

/** Bundles weft-core with wrangler's dry run and scans it from src/core/index.ts. */
export function scanCoreBundle(o: { appsCf?: string; config?: string } = {}): ScanResult {
  const appsCf = o.appsCf ?? APPS_CF;
  const out = mkdtempSync(join(tmpdir(), "weft-core-scan-"));
  try {
    return withSnapshotStandIns(join(appsCf, "generated"), () => {
      execFileSync(join(appsCf, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out, "--metafile", join(out, "meta.json"), "-c", o.config ?? "wrangler.core.jsonc"], {
        cwd: appsCf, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      });
      return scanImports(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as Metafile, (p) => p.endsWith("src/core/index.ts"));
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
