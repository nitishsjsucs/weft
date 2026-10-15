// Secret loading (harness 11.1). A secret comes from the environment or from the KEY=VALUE file named by
// WEFT_SECRETS_FILE, which lives outside the repo. Values are never logged, never copied into process.env and never
// written anywhere; callers keep them in memory only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type Env = Record<string, string | undefined>;

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** Parse a dotenv-style file: `KEY=value`, optional `export `, quotes, `#` comments. */
export function parseSecretsFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out.set(m[1]!, v);
  }
  return out;
}

/** The named secret, or null. Reads the file on every call so a rotated key is picked up; never caches in env. */
export function loadSecret(name: string, env: Env): string | null {
  const direct = env[name];
  if (direct && direct.trim()) return direct.trim();
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

/** For error messages: say whether a secret is present without ever showing it. */
export function describeSecret(value: string | null): string {
  return value ? `set (${value.length} chars)` : "missing";
}
