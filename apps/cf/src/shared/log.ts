// One JSON line per notable event (design 10): {evt, slot, gen, run, step, outcome, ms, rowsRead, rowsWritten}.
// Weft's fields never carry prompts, keys, cookies or raw IPs; as a backstop every string is scrubbed of the
// credential shapes Weft uses before it is written.
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/g,          // provider keys
  /weft_sk_[0-9a-f]{16,}/g,          // Weft API keys
  /wk_mcp_[a-z0-9-]+_\d+_[A-Za-z0-9]{8,}/g, // hosted MCP keys
  /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}/g, // session, grant and ctx tokens
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,    // IPv4 addresses
];

export function scrub(s: string): string {
  let out = s;
  for (const re of SECRET_SHAPES) out = out.replace(re, "[redacted]");
  return out.length > 600 ? `${out.slice(0, 600)}...` : out;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(evt: string, fields: LogFields = {}): void {
  const line: Record<string, string | number | boolean | null> = { evt };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    line[k] = typeof v === "string" ? scrub(v) : v;
  }
  console.log(JSON.stringify(line));
}

export function logError(evt: string, err: unknown, fields: LogFields = {}): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  logEvent(evt, { ...fields, outcome: "error", error: message, ...(typeof code === "string" ? { code } : {}) });
}
