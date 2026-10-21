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

export async function readJson<T>(req: Request, maxBytes = 16 * 1024): Promise<T | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
