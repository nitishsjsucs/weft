// Secrets files for the cf scripts (docs/cloudflare/design.md 9.3). Values are read with awk (env-value.awk), never by
// sourcing the file, and handed to one child command's environment or stdin; nothing here prints a value. New
// values are written to ~/Developer/projects/.weft.cf.secrets.env (mode 600, outside the repo) one KEY=value line
// each, replacing an existing line of the same name.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CF_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(dirname(CF_DIR));
export const AWK = join(CF_DIR, "env-value.awk");

/** The generated secrets (gateway name, Turnstile secret, the HMAC secrets, the vault key). */
export const CF_SECRETS_FILE = process.env.WEFT_CF_SECRETS_FILE ?? join(homedir(), "Developer/projects/.weft.cf.secrets.env");
/** Weft's own secrets (OPENAI_API_KEY). */
export const WEFT_SECRETS_FILE = process.env.WEFT_SECRETS_FILE ?? join(homedir(), "Developer/projects/.weft.secrets.env");

/** One value from a secrets file, or null. Parsed with awk; the file is never sourced. */
export function readEnvValue(file: string, key: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new Error(`not an env name: ${key.slice(0, 20)}`);
  if (!existsSync(file)) return null;
  const v = execFileSync("awk", ["-v", `key=${key}`, "-f", AWK, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return v.length ? v : null;
}

/** Sets KEY=value in a secrets file (created mode 600), replacing an existing line of that name. Prints nothing. */
export function writeEnvValue(file: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new Error(`not an env name: ${key.slice(0, 20)}`);
  if (/[\r\n]/.test(value)) throw new Error(`${key}: a value cannot span lines`);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const kept = lines.filter((l) => !re.test(l) && l !== "");
  kept.push(`${key}=${value}`);
  writeFileSync(file, kept.join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The secret, generated (random, never printed) and stored when the file does not hold it yet. */
export function ensureEnvValue(file: string, key: string, make: () => string): { value: string; created: boolean } {
  const cur = readEnvValue(file, key);
  if (cur) return { value: cur, created: false };
  const value = make();
  writeEnvValue(file, key, value);
  return { value, created: true };
}

export const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Every secret each Worker holds (design 9.3) and where its value comes from. */
export const WORKER_SECRETS: readonly { name: string; workers: ("weft-core" | "weft")[]; source: "generated" | "resources" | "weft" | "optional"; make?: () => string }[] = [
  { name: "WEFT_VAULT_KEY", workers: ["weft-core"], source: "generated", make: () => hex(32) },
  { name: "WEFT_PROXY_SECRET", workers: ["weft-core", "weft"], source: "generated", make: () => hex(32) },
  { name: "WEFT_CTX_SECRET", workers: ["weft-core", "weft"], source: "generated", make: () => hex(32) },
  { name: "WEFT_SESSION_SECRET", workers: ["weft-core", "weft"], source: "generated", make: () => hex(32) },
  { name: "WEFT_SMOKE_TOKEN", workers: ["weft"], source: "generated", make: () => hex(32) },
  { name: "WEFT_ADMIN_TOKEN", workers: ["weft"], source: "generated", make: () => hex(32) },
  { name: "TURNSTILE_SECRET", workers: ["weft"], source: "resources" },
  { name: "WEFT_AIG_GATEWAY", workers: ["weft-core"], source: "resources" },
  { name: "OPENAI_API_KEY", workers: ["weft-core"], source: "weft" },
  { name: "CF_AIG_TOKEN", workers: ["weft-core"], source: "optional" },
];
