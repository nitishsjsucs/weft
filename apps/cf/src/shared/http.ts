// Small HTTP helpers shared by the front Worker and the Durable Objects: the hosted error body, JSON responses,
// cookie parsing and the UTC day helpers every daily counter keys by.
import { HOSTED_ERRORS, type HostedErrorBody, type HostedErrorCode } from "./contracts";

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** The usual `{ _tag, message, code }` body with the hosted status (428 and 503 are not ERROR_STATUS[_tag]). */
export function hostedError(code: HostedErrorCode, message: string, extra: { retryAfterS?: number; headers?: HeadersInit } = {}): Response {
  const def = HOSTED_ERRORS[code];
  const body: HostedErrorBody = { _tag: def.tag, code, message, ...(extra.retryAfterS !== undefined ? { retryAfterS: extra.retryAfterS } : {}) };
  const headers = new Headers(extra.headers);
  if (extra.retryAfterS !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(extra.retryAfterS))));
  return json(body, { status: def.status, headers });
}

/** A plain `{ _tag, message, code }` error that is not one of the hosted gate codes (for example a 404). */
export function plainError(status: number, tag: string, code: string, message: string): Response {
  return json({ _tag: tag, code, message }, { status });
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** `__Host-` cookies: Secure, Path=/, no Domain; HttpOnly and SameSite=Strict as design 6.2 asks. */
export function setCookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeS))}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
export const clearCookie = (name: string): string => setCookie(name, "", 0);

export const utcDay = (ms: number = Date.now()): string => new Date(ms).toISOString().slice(0, 10);
export function nextUtcMidnight(ms: number = Date.now()): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export const isMutation = (method: string): boolean => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/** Admin bodies are small JSON objects (the front's /api/_admin/* routes). */
export const ADMIN_MAX_BODY_BYTES = 64 * 1024;

/**
 * A request body as text, at most `maxBytes`, or null when it is larger: a declared Content-Length over the cap is
 * refused before anything is read, and a body without one (chunked) is read only until it passes the cap.
 */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * A small JSON request body (the lease, verify and reset bodies, the model switch), or null when it is larger than
 * `maxBytes` or not JSON. The cap holds for a body of unknown length too (readTextCapped), so a chunked body is never
 * buffered past it. An empty body is `{}`.
 */
export async function readJson<T>(req: Request, maxBytes = 16 * 1024): Promise<T | null> {
  const text = await readTextCapped(req, maxBytes);
  if (text === null) return null;
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
