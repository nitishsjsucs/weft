// Secret parsing and the environment-only lookup (harness 11.1; docs/cloudflare/design.md 9.3). Portable: the durable
// platform's secrets are Worker secrets and vars only (no secrets file, no process.env), so its provider factory uses
// envSecret. Values are never logged, never copied into an environment and never written anywhere.
export type Env = Record<string, string | undefined>;

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

/** The named secret from the environment only, trimmed, or null. */
export function envSecret(name: string, env: Env): string | null {
  const direct = env[name];
  return direct && direct.trim() ? direct.trim() : null;
}

/** For error messages: say whether a secret is present without ever showing it. */
export function describeSecret(value: string | null): string {
  return value ? `set (${value.length} chars)` : "missing";
}
