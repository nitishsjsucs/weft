
/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");
// Secret lookup for real vendor adapters (docs/wave3.md). Reads only the file named by WEFT_SECRETS_FILE (KEY=VALUE lines),
// never process.env values, and never logs, returns to the UI or persists a value. presence() reports names only.
// On Cloudflare (WEFT_RUNTIME=cloudflare, docs/cloudflare/design.md 4.1) there is no secrets file and no file system:
// a secret is a Worker secret, so the named values come from the Worker env only, and nothing is read from disk.

export type Env = Record<string, string | undefined>;

/** True on the hosted runtime, where secrets are Worker secrets and WEFT_SECRETS_FILE is never read. */
export const workerSecretsOnly = (env: Env): boolean => env.WEFT_RUNTIME === "cloudflare";

function parse(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  if (workerSecretsOnly(env)) {
    for (const [k, v] of Object.entries(env)) if (/^[A-Z0-9_]+$/.test(k) && typeof v === "string" && v.trim()) out.set(k, v.trim());
    return out;
  }
  const file = env.WEFT_SECRETS_FILE;
  if (!file) return out;
  let text = "";
  try { text = fs().readFileSync(file, "utf8"); } catch { return out; }
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
