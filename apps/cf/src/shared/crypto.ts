// WebCrypto helpers shared by the front Worker, the Durable Objects and the Node scripts (Node 25 has the same
// globals). HMAC-SHA256 only, keys imported once per isolate, verification through crypto.subtle.verify so the
// comparison is constant time. Nothing here imports @weft/*.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s) as Uint8Array<ArrayBuffer>;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** Whether two secrets are equal, in time that depends only on their length (which a key's format already shows). */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Uniform alphanumeric string (rejection sampling, no modulo bias). */
export function randomAlnum(length: number): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const x of buf) {
      if (x < 248) out += ALNUM[x % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();
/** One imported HMAC key per (label, secret) per isolate. The map key is a hash, so secrets never sit in it. */
async function hmacKey(secret: string): Promise<CryptoKey> {
  const id = await sha256Hex(`weft-key|${secret}`);
  let k = keys.get(id);
  if (!k) {
    k = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(id, k);
    if (keys.size > 64) keys.delete(keys.keys().next().value as string);
  }
  return k;
}

export async function hmac(secret: string, message: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(message)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await hmac(secret, message));
}

export async function hmacVerify(secret: string, message: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (signature.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(message));
}

/**
 * A signed token: `v1.<base64url(JSON)>.<base64url(HMAC(secret, label|payload))>`. The label separates the token
 * kinds that share a secret (the session cookie and the human grant), so one can never stand in for the other.
 */
export async function signToken(secret: string, label: string, claims: unknown): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  return `v1.${payload}.${toBase64Url(await hmac(secret, `${label}|${payload}`))}`;
}

export type TokenCheck<T> = { ok: true; claims: T } | { ok: false; reason: "malformed" | "signature" };

export async function verifyToken<T>(secret: string, label: string, token: string): Promise<TokenCheck<T>> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1]!.length > 4096) return { ok: false, reason: "malformed" };
  const sig = fromBase64Url(parts[2]!);
  const body = fromBase64Url(parts[1]!);
  if (!sig || !body) return { ok: false, reason: "malformed" };
  if (!(await hmacVerify(secret, `${label}|${parts[1]}`, sig))) return { ok: false, reason: "signature" };
  try {
    return { ok: true, claims: JSON.parse(fromUtf8(body)) as T };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
