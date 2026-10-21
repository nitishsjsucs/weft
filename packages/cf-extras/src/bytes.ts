// Small byte and text helpers that run the same in workerd and on Node: Web Crypto for sha256, a chunked base64
// encoder, content sniffing, HTML escaping and the UTC day the daily counters and caps reset on. Track cf6-extras.

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Base64 without Buffer (workerd) and without one giant String.fromCharCode spread. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

export type SniffedKind = "jpeg" | "png" | "gif" | "webp" | "pdf" | "wav" | "webm" | "ogg" | "mp4" | "mp3" | "text" | "unknown";

/** What the bytes are, from their magic numbers (never from the client's content type alone). */
export function sniff(bytes: Uint8Array): SniffedKind {
  const at = (i: number, ...v: number[]) => v.every((x, k) => bytes[i + k] === x);
  const ascii = (i: number, s: string) => [...s].every((ch, k) => bytes[i + k] === ch.charCodeAt(0));
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (ascii(0, "GIF8")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (ascii(0, "%PDF-")) return "pdf";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (ascii(0, "OggS")) return "ogg";
  if (ascii(4, "ftyp")) return "mp4";
  if (ascii(0, "ID3") || at(0, 0xff, 0xfb) || at(0, 0xff, 0xf3) || at(0, 0xff, 0xf2)) return "mp3";
  if (bytes.length > 0 && isLikelyText(bytes)) return "text";
  return "unknown";
}

function isLikelyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) return false;
  }
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)); return true; } catch { return n === 4096; }
}

export const IMAGE_KINDS: readonly SniffedKind[] = ["jpeg", "png", "gif", "webp"];
export const MIME_OF: Partial<Record<SniffedKind, string>> = {
  jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", text: "text/plain",
  wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4", mp3: "audio/mpeg",
};

/** A content type from an upload's file name, for the job body (the consumer sniffs the bytes again). */
export function contentTypeOfName(fileName: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/plain" };
  return map[ext] ?? "application/octet-stream";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** YYYY-MM-DD in UTC: daily counters and the hosted caps reset at 00:00 UTC (design 8.2). */
export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

/** Collapses whitespace and strips control characters, then clips (with no partial surrogate pair). */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** "10.62", "$1,234.5" or "1234" to integer cents with no float math; null when it is not an amount. */
export function amountToCents(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return null;
    v = v.toFixed(2);
  }
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s$,]/g, "").replace(/^(USD|EUR|GBP|CAD)/i, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** A real calendar date as YYYY-MM-DD, or null. */
export function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}` ? null : `${m[1]}-${m[2]}-${m[3]}`;
}
