// Secret lookup for real vendor adapters (docs/wave3.md). Reads only the file named by WEFT_SECRETS_FILE (KEY=VALUE lines),
// never process.env values, and never logs, returns to the UI or persists a value. presence() reports names only.
import { readFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

function parse(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  const file = env.WEFT_SECRETS_FILE;
  if (!file) return out;
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2]!.replace(/^["']|["']$/g, "");
    if (v) out.set(m[1]!, v);
  }
  return out;
}

/** Which of the named secrets resolve, as booleans. Safe to show in the UI. */
export function secretPresence(names: readonly string[], env: Env): Record<string, boolean> {
  const all = parse(env);
  return Object.fromEntries(names.map((n) => [n, all.has(n)]));
}

/** The value for a real adapter only. Throws when missing; the message names the key, never a value. */
export function readSecret(name: string, env: Env): string {
  const v = parse(env).get(name);
  if (!v) throw new Error(`secret ${name} is not set in WEFT_SECRETS_FILE`);
  return v;
}
