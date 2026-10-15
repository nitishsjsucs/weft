// Next 16 proxy (formerly middleware): adds x-weft-proxy to /api/* requests before next.config.ts rewrites them
// to the API. The secret is read from $WEFT_DATA_DIR/run/proxy.secret (default <repo>/.data) and never sent to the browser.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextResponse, type NextRequest } from "next/server";

const secretFile = join(resolve(/*turbopackIgnore: true*/ process.env.WEFT_DATA_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), "../../.data")), "run", "proxy.secret");

function readSecret(): string | null {
  try { return readFileSync(secretFile, "utf8").trim() || null; } catch { return null; }
}

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete("x-weft-proxy");
  const secret = readSecret();
  if (secret) headers.set("x-weft-proxy", secret);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: "/api/:path*" };
