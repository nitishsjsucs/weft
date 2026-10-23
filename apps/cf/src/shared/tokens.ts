// The signed values the hosted path trusts (design 3.4, 6.2 and 6.4): the session cookie and the human grant
// (WEFT_SESSION_SECRET), the x-weft-ctx header the front sets for a Durable Object (WEFT_CTX_SECRET), the smoke
// header (WEFT_SMOKE_TOKEN) and the admin signature (WEFT_ADMIN_TOKEN), which also derives the operator lease's
// visitor id. The scripts (cf7's smoke, cf:dev) import
// signAdmin and signSmoke from here, so the format lives in one file.
import { hmac, hmacVerify, signToken, fromHex, randomHex, sha256Hex, toHex, utf8, verifyToken } from "./crypto";
import type { HumanGrantClaims, SessionClaims, WeftCtx } from "./contracts";

const SESSION_LABEL = "weft-session";
const GRANT_LABEL = "weft-grant";
const CTX_LABEL = "weft-ctx";
/** x-weft-ctx is set per request inside Cloudflare; a stale one (more than this old) is refused. */
export const CTX_MAX_AGE_S = 300;
/** Smoke and admin signatures carry a timestamp that must be within this window (design 9.2: 5 minutes). */
export const SIGNATURE_WINDOW_S = 300;
/** How far ahead of this clock a signature's timestamp may be (clock skew only), so a signature cannot be dated
 * ahead to last longer than the window. */
export const SIGNATURE_FUTURE_S = 30;
const tsFresh = (ts: number, nowS: number) => nowS - ts <= SIGNATURE_WINDOW_S && ts - nowS <= SIGNATURE_FUTURE_S;

const SLOT_RE = /^[a-z0-9-]{1,32}$/;
const VISITOR_RE = /^vis_[0-9a-f]{32}$/;

export const sessionToken = (secret: string, c: SessionClaims): Promise<string> => signToken(secret, SESSION_LABEL, c);
export const grantToken = (secret: string, c: HumanGrantClaims): Promise<string> => signToken(secret, GRANT_LABEL, c);

export type Checked<T> = { ok: true; claims: T } | { ok: false; reason: "malformed" | "signature" | "expired" };

export async function readSession(secret: string, token: string, nowS = Math.floor(Date.now() / 1000)): Promise<Checked<SessionClaims>> {
  const r = await verifyToken<SessionClaims>(secret, SESSION_LABEL, token);
  if (!r.ok) return r;
  const c = r.claims;
  if (typeof c?.visitor !== "string" || !VISITOR_RE.test(c.visitor) || typeof c.slot !== "string" || !SLOT_RE.test(c.slot)
    || !Number.isInteger(c.gen) || c.gen < 0 || !Number.isInteger(c.exp)) return { ok: false, reason: "malformed" };
  if (c.exp <= nowS) return { ok: false, reason: "expired" };
  return { ok: true, claims: { visitor: c.visitor, slot: c.slot, gen: c.gen, exp: c.exp } };
}

export async function readGrant(secret: string, token: string, nowS = Math.floor(Date.now() / 1000)): Promise<Checked<HumanGrantClaims>> {
  const r = await verifyToken<HumanGrantClaims>(secret, GRANT_LABEL, token);
  if (!r.ok) return r;
  const c = r.claims;
  if (typeof c?.visitor !== "string" || !VISITOR_RE.test(c.visitor) || !Number.isInteger(c.exp)) return { ok: false, reason: "malformed" };
  if (c.exp <= nowS) return { ok: false, reason: "expired" };
  return { ok: true, claims: { visitor: c.visitor, exp: c.exp } };
}

export const signCtx = (secret: string, ctx: WeftCtx): Promise<string> => signToken(secret, CTX_LABEL, ctx);

export async function readCtx(secret: string, header: string | null, nowS = Math.floor(Date.now() / 1000)): Promise<Checked<WeftCtx>> {
  if (!header) return { ok: false, reason: "malformed" };
  const r = await verifyToken<WeftCtx>(secret, CTX_LABEL, header);
  if (!r.ok) return r;
  const c = r.claims;
  if (typeof c?.slot !== "string" || !SLOT_RE.test(c.slot) || !Number.isInteger(c.gen) || !Number.isInteger(c.iat)
    || typeof c.human !== "boolean" || typeof c.smoke !== "boolean"
    || (c.visitor !== null && typeof c.visitor !== "string") || (c.ipHash !== null && typeof c.ipHash !== "string")) return { ok: false, reason: "malformed" };
  if (Math.abs(nowS - c.iat) > CTX_MAX_AGE_S) return { ok: false, reason: "expired" };
  return { ok: true, claims: { slot: c.slot, gen: c.gen, visitor: c.visitor, ipHash: c.ipHash, human: c.human, smoke: c.smoke, iat: c.iat } };
}

export function newVisitorId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `vis_${toHex(b)}`;
}

// Smoke and admin --------------------------------------------------------------------------------------------------

/** The request a smoke header was signed for: its method and URL path (no query). */
export interface SmokeRequest { method: string; path: string }
const smokeMessage = (r: SmokeRequest, ts: number) => `weft-smoke|${r.method.toUpperCase()}|${r.path}|${ts}`;

/**
 * `x-weft-smoke: <unix seconds>.<hex HMAC(WEFT_SMOKE_TOKEN, "weft-smoke|<METHOD>|<path>|<ts>")>`. Bound to the method
 * and path, so a header that leaks (a log, a proxy) works only for that one request shape within its window.
 */
export async function signSmoke(token: string, req: SmokeRequest, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  return `${nowS}.${toHex(await hmac(token, smokeMessage(req, nowS)))}`;
}

export async function verifySmoke(token: string | undefined, header: string | null, req: SmokeRequest, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!token || !header) return false;
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (!tsFresh(ts, nowS)) return false;
  return hmacVerify(token, smokeMessage(req, ts), fromHex(m[2]!)!);
}

export const ADMIN_HEADER = "x-weft-admin";
const adminMessage = (method: string, path: string, ts: number, nonce: string, bodyHash: string) => `weft-admin|${method.toUpperCase()}|${path}|${ts}|${nonce}|${bodyHash}`;

/**
 * `x-weft-admin: <unix seconds>.<nonce>.<hex HMAC(WEFT_ADMIN_TOKEN, "weft-admin|<METHOD>|<path>|<ts>|<nonce>|<sha256(body)>")>`.
 * The nonce (16 random hex digits) makes every signature distinct, even two identical requests in one second, so the
 * front can take each one once (adminSignatureId).
 */
export async function signAdmin(input: { token: string; method: string; path: string; body?: string; nowS?: number; nonce?: string }): Promise<string> {
  const ts = input.nowS ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomHex(8);
  const bodyHash = await sha256Hex(input.body ?? "");
  return `${ts}.${nonce}.${toHex(await hmac(input.token, adminMessage(input.method, input.path, ts, nonce, bodyHash)))}`;
}

export type AdminCheck = { ok: true; ts: number; id: string } | { ok: false };

/**
 * Checks the admin signature: the token, the method, path, timestamp (at most SIGNATURE_WINDOW_S old and
 * SIGNATURE_FUTURE_S ahead), nonce and body. `id` names the signature for the single-use check, and `ts` its day.
 */
export async function verifyAdmin(input: { token: string | undefined; header: string | null; method: string; path: string; body: string; nowS?: number }): Promise<AdminCheck> {
  if (!input.token || input.token.length < 32 || !input.header) return { ok: false };
  const m = /^(\d{9,11})\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(input.header);
  if (!m) return { ok: false };
  const ts = Number(m[1]);
  if (!tsFresh(ts, input.nowS ?? Math.floor(Date.now() / 1000))) return { ok: false };
  const bodyHash = await sha256Hex(input.body);
  if (!(await hmacVerify(input.token, adminMessage(input.method, input.path, ts, m[2]!, bodyHash), fromHex(m[3]!)!))) return { ok: false };
  return { ok: true, ts, id: m[3]!.slice(0, 32) };
}

/** Operator lease names (POST /api/_admin/lease): one lease per name, so a smoke and a walkthrough can hold two. */
export const OPERATOR_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_OPERATOR = "operator";

/** The visitor id an operator lease runs as (design 6.2): derived from WEFT_ADMIN_TOKEN and the lease name, so it is
 * stable per name (asking again returns the same lease), has the cookie's shape, and cannot be made without the token. */
export async function operatorVisitorId(adminToken: string, name: string): Promise<string> {
  return `vis_${toHex(await hmac(adminToken, `weft-operator|${name}`)).slice(0, 32)}`;
}

/** The eight 16-bit groups of an IPv6 address (compressed forms and a dotted IPv4 tail included), or null. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return null;
    const b = tail.split(".").map(Number);
    if (b.some((n) => n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all.map((g) => Number.parseInt(g, 16)) : null;
}

/**
 * What a per-IP key counts (design 6.4): an IPv4 address as it is, an IPv6 address by its /64 prefix, since one
 * subscriber is handed a whole /64 and could otherwise take a fresh lease, rate limit and cap from each of its 2^64
 * addresses, and an IPv4-mapped IPv6 address as its IPv4 address. Anything that does not parse is kept as given.
 */
export function ipKeyOf(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[")) s = s.slice(1, s.includes("]") ? s.indexOf("]") : undefined);
  if (s.includes("%")) s = s.slice(0, s.indexOf("%"));
  if (!s.includes(":")) return s;
  const g = ipv6Groups(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The daily-salted IP hash (design 6.4): the salt is derived from WEFT_SESSION_SECRET and the UTC day, so raw IPs
 * are never stored and a hash cannot be linked across days. Every per-IP key (leases, rate limits, spend caps) is
 * this hash, so an IPv6 visitor counts once per /64 (ipKeyOf). */
export async function ipHash(sessionSecret: string, ip: string, day: string): Promise<string> {
  return toHex(await hmac(sessionSecret, `weft-ip|${day}|${ipKeyOf(ip)}`)).slice(0, 32);
}

/** A short stable id for an MCP key (rate limit and per-key counters); the key itself is never stored here. */
export async function mcpKeyId(key: string): Promise<string> {
  return (await sha256Hex(utf8(`weft-mcp|${key}`))).slice(0, 24);
}
