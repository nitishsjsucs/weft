// Ported from StaySignal src/shared/canonical-json.ts (MIT, Copyright (c) 2026 Nitish Chowdary; see NOTICE).
// Canonical JSON: sorted keys by code point, safe integers only, non-ASCII escaped. Used for hashes and digests.
export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i === 0 ? (b.length - j === 0 ? 0 : -1) : 1;
}

function quote(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return quote(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`${path}: only safe integers are allowed, got ${String(value)}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`${path}: unsupported object type`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareCodePoints);
      return `{${keys.map((k) => `${quote(k)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path}: unsupported type ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}
