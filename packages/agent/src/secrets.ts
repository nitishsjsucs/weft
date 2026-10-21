// Secret loading (harness 11.1). A secret comes from the environment or from the KEY=VALUE file named by
// WEFT_SECRETS_FILE, which lives outside the repo. Values are never logged, never copied into process.env and never
// written anywhere; callers keep them in memory only. Node only: the durable platform reads the environment alone
// (secrets-core.ts envSecret).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { envSecret, parseSecretsFile, type Env } from "./secrets-core";

export { describeSecret, envSecret, parseSecretsFile, type Env } from "./secrets-core";

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** The named secret, or null. Reads the file on every call so a rotated key is picked up; never caches in env. */
export function loadSecret(name: string, env: Env): string | null {
  const direct = envSecret(name, env);
  if (direct) return direct;
  const file = env.WEFT_SECRETS_FILE;
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(expandHome(file), "utf8");
  } catch {
    return null;
  }
  const v = parseSecretsFile(text).get(name);
  return v && v.trim() ? v.trim() : null;
}
