// Webhook signature helpers shared by every vendor (docs/wave3.md). Always over the raw request bytes, constant-time compare.
import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256(key: string, raw: Uint8Array, encoding: "hex" | "base64"): string {
  return createHmac("sha256", key).update(raw).digest(encoding);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
