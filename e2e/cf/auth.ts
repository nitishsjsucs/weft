// The two tokens the hosted checks sign with (docs/cloudflare/design.md 6.2, 9.3 and 11.6), track cf7-integrate:
// WEFT_SMOKE_TOKEN (the x-weft-smoke header: a human session restricted to slot-smoke, scripted provider) and
// WEFT_ADMIN_TOKEN (the x-weft-admin signature on /api/_admin/*, the operator lease included).
//
// Values are read from a secrets file with scripts/cf/env-value.awk, never by sourcing it, and stay inside the closure
// below: nothing here prints, logs or returns a token, only the signatures made with it (which expire in 5 minutes).
// The file is, in order: WEFT_CF_TOKENS_FILE; for a local target, the cf:dev state dir's secrets.env (cf:dev writes
// random local values there); for a deployed target, the cf secrets file (WEFT_CF_SECRETS_FILE, default
// ~/Developer/projects/.weft.cf.secrets.env, mode 600, outside the repo).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signAdmin, signSmoke } from "../../apps/cf/src/shared/tokens";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const AWK = join(REPO_ROOT, "scripts/cf/env-value.awk");

/** cf7's local stack (playwright.cf.config.ts and the local smoke): port 5800, the siteverify stub on 5809. */
export const LOCAL = {
  port: 5800,
  origin: "http://localhost:5800",
  stubPort: 5809,
  dir: ".scratch/cf7/cf-dev-e2e",
} as const;
export const DEPLOYED_ORIGIN = "https://weft.nitish-ratakonda.workers.dev";

export type TargetKind = "local" | "deployed";

/** A target is local when it is a loopback cf:dev (wrangler dev), whatever its port. */
export function targetKind(origin: string): TargetKind {
  const h = new URL(origin).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" ? "local" : "deployed";
}

export function tokensFile(kind: TargetKind, env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEFT_CF_TOKENS_FILE) return env.WEFT_CF_TOKENS_FILE;
  if (kind === "local") return join(REPO_ROOT, LOCAL.dir, "secrets.env");
  return env.WEFT_CF_SECRETS_FILE ?? join(homedir(), "Developer/projects/.weft.cf.secrets.env");
}

/** One value by awk, or null. The value never leaves this module except through the signers. */
function readValue(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  const v = execFileSync("awk", ["-v", `key=${key}`, "-f", AWK, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return v.length ? v : null;
}

export interface Signers {
  /** Where the tokens came from (a path, never a value). */
  readonly file: string;
  /** A fresh x-weft-smoke header value. */
  smoke(method: string, path: string): Promise<string>;
  /** A fresh x-weft-admin header value for this request. */
  admin(method: string, path: string, body?: string): Promise<string>;
}

/** Signers over the tokens in `file`. Throws naming the key and the file (never a value) when one is missing. */
export function signers(file: string): Signers {
  const smokeToken = readValue(file, "WEFT_SMOKE_TOKEN");
  const adminToken = readValue(file, "WEFT_ADMIN_TOKEN");
  const missing = [smokeToken ? null : "WEFT_SMOKE_TOKEN", adminToken ? null : "WEFT_ADMIN_TOKEN"].filter(Boolean);
  if (missing.length) throw new Error(`${missing.join(" and ")} not found in ${file.replace(homedir(), "~")}`);
  return {
    file,
    // The front verifies the pathname only (no query string), so the signature covers the same.
    smoke: (method, path) => signSmoke(smokeToken!, { method, path: path.split("?")[0]! }),
    admin: (method, path, body = "") => signAdmin({ token: adminToken!, method, path, body }),
  };
}

export const ADMIN_HEADER = "x-weft-admin";
export const SMOKE_HEADER = "x-weft-smoke";
