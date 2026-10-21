// Run artifact and sandbox code bodies (harness 7.4 and 3.5) behind the RunFileStore seam (docs/cloudflare/design.md
// 4.1). The key is the dataDir-relative path the run_artifacts row records, companies/<cmp>/runs/<run>/artifacts/
// <n>-<wire>.json, with "/" separators. Node keeps today's files under the data dir; the durable platform keeps the
// bodies in the run_files table (apps/api/src/platform/sql.ts), where they commit and roll back with the command.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RunFileStore } from "../../../contracts/src/ext/cf-platform";

export type { RunFileStore } from "../../../contracts/src/ext/cf-platform";

/** companies/<company>/runs/<run>: the run workspace, relative to the data dir. */
export function runRel(companyId: string, runId: string): string {
  return `companies/${companyId}/runs/${runId}`;
}

/** Refuses a key that is absolute, has a backslash or NUL, or climbs out with "..". */
export function safeRunFileKey(path: string): string {
  if (typeof path !== "string" || !path || path.length > 400) throw new Error("run file key is required (at most 400 characters)");
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) throw new Error(`unsafe run file key ${JSON.stringify(path).slice(0, 60)}`);
  if (path.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`unsafe run file key ${JSON.stringify(path).slice(0, 60)}`);
  return path;
}

/** Node: one file per key under the data dir, as before the seam existed. */
export function fileRunFiles(dataDir: string): RunFileStore {
  const root = resolve(dataDir);
  const abs = (key: string) => {
    const f = resolve(join(root, safeRunFileKey(key)));
    if (!f.startsWith(root + sep)) throw new Error("run file key escapes the data dir");
    return f;
  };
  return {
    async write(path, body) {
      const f = abs(path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body);
    },
    async read(path) {
      let f: string;
      try { f = abs(path); } catch { return null; }
      try { return readFileSync(f, "utf8"); } catch { return null; }
    },
    async removePrefix(prefix) {
      rmSync(abs(prefix.replace(/\/+$/, "")), { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}
