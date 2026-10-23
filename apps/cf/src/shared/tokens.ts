// The signed values the hosted path trusts (design 3.4, 6.2 and 6.4): the session cookie and the human grant
// (WEFT_SESSION_SECRET), the x-weft-ctx header the front sets for a Durable Object (WEFT_CTX_SECRET), the smoke
// header (WEFT_SMOKE_TOKEN) and the admin signature (WEFT_ADMIN_TOKEN), which also derives the operator lease's
// visitor id. The scripts (cf7's smoke, cf:dev) import
// signAdmin and signSmoke from here, so the format lives in one file.
import { hmac, hmacVerify, signToken, fromHex, sha256Hex, toHex, utf8, verifyToken } from "./crypto";
import type { HumanGrantClaims, SessionClaims, WeftCtx } from "./contracts";

const SESSION_LABEL = "weft-session";
const GRANT_LABEL = "weft-grant";
const CTX_LABEL = "weft-ctx";
/** x-weft-ctx is set per request inside Cloudflare; a stale one (more than this old) is refused. */
export const CTX_MAX_AGE_S = 300;
/** Smoke and admin signatures carry a timestamp that must be within this window (design 9.2: 5 minutes). */
export const SIGNATURE_WINDOW_S = 300;

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

/** `x-weft-smoke: <unix seconds>.<hex HMAC(WEFT_SMOKE_TOKEN, "weft-smoke|<ts>")>`. */
export async function signSmoke(token: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  return `${nowS}.${toHex(await hmac(token, `weft-smoke|${nowS}`))}`;
}

export async function verifySmoke(token: string | undefined, header: string | null, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!token || !header) return false;
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(nowS - ts) > SIGNATURE_WINDOW_S) return false;
  return hmacVerify(token, `weft-smoke|${ts}`, fromHex(m[2]!)!);
}

export const ADMIN_HEADER = "x-weft-admin";

/** `x-weft-admin: <unix seconds>.<hex HMAC(WEFT_ADMIN_TOKEN, "weft-admin|<METHOD>|<path>|<ts>|<sha256(body)>")>`. */
export async function signAdmin(input: { token: string; method: string; path: string; body?: string; nowS?: number }): Promise<string> {
  const ts = input.nowS ?? Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(input.body ?? "");
  return `${ts}.${toHex(await hmac(input.token, `weft-admin|${input.method.toUpperCase()}|${input.path}|${ts}|${bodyHash}`))}`;
}

export async function verifyAdmin(input: { token: string | undefined; header: string | null; method: string; path: string; body: string; nowS?: number }): Promise<boolean> {
  if (!input.token || input.token.length < 32 || !input.header) return false;
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(input.header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs((input.nowS ?? Math.floor(Date.now() / 1000)) - ts) > SIGNATURE_WINDOW_S) return false;
  const bodyHash = await sha256Hex(input.body);
  return hmacVerify(input.token, `weft-admin|${input.method.toUpperCase()}|${input.path}|${ts}|${bodyHash}`, fromHex(m[2]!)!);
}

/** Operator lease names (POST /api/_admin/lease): one lease per name, so a smoke and a walkthrough can hold two. */
export const OPERATOR_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_OPERATOR = "operator";

/** The visitor id an operator lease runs as (design 6.2): derived from WEFT_ADMIN_TOKEN and the lease name, so it is
 * stable per name (asking again returns the same lease), has the cookie's shape, and cannot be made without the token. */
export async function operatorVisitorId(adminToken: string, name: string): Promise<string> {
  return `vis_${toHex(await hmac(adminToken, `weft-operator|${name}`)).slice(0, 32)}`;
}

/** The daily-salted IP hash (design 6.4): the salt is derived from WEFT_SESSION_SECRET and the UTC day, so raw IPs
 * are never stored and a hash cannot be linked across days. */
export async function ipHash(sessionSecret: string, ip: string, day: string): Promise<string> {
  return toHex(await hmac(sessionSecret, `weft-ip|${day}|${ip}`)).slice(0, 32);
}

/** A short stable id for an MCP key (rate limit and per-key counters); the key itself is never stored here. */
export async function mcpKeyId(key: string): Promise<string> {
  return (await sha256Hex(utf8(`weft-mcp|${key}`))).slice(0, 24);
}
