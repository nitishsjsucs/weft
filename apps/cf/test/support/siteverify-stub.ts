// A local stand-in for Turnstile's siteverify (design 11.4), so the Miniflare suite never needs the network. The front
// Worker reaches it through TURNSTILE_VERIFY_URL (apps/cf/src/shared/env.ts). It answers with Cloudflare's published
// test-secret semantics (developers.cloudflare.com/turnstile/troubleshooting/testing/):
//
//   1x0000000000000000000000000000000AA  always passes, and accepts only the dummy token XXXX.DUMMY.TOKEN.XXXX
//   2x0000000000000000000000000000000AA  always fails (invalid-input-response)
//   3x0000000000000000000000000000000AA  always fails as already spent (timeout-or-duplicate)
//
// Any other secret is refused as invalid-input-secret (production secrets never reach a test), a missing secret or
// token as missing-input-*. Each call is recorded without the secret, so a case can check what the front sent.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TEST_SECRETS = {
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
  spent: "3x0000000000000000000000000000000AA",
} as const;
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export interface SiteverifyCall { secretKind: "pass" | "fail" | "spent" | "other" | "missing"; response: string | null; remoteip: string | null; idempotencyKey: string | null }
export interface SiteverifyAnswer { success: boolean; "error-codes": string[]; hostname?: string; challenge_ts?: string }

export function answerFor(secret: string | null, response: string | null): { kind: SiteverifyCall["secretKind"]; body: SiteverifyAnswer } {
  if (!secret) return { kind: "missing", body: { success: false, "error-codes": ["missing-input-secret"] } };
  const kind = secret === TEST_SECRETS.pass ? "pass" : secret === TEST_SECRETS.fail ? "fail" : secret === TEST_SECRETS.spent ? "spent" : "other";
  if (kind === "other") return { kind, body: { success: false, "error-codes": ["invalid-input-secret"] } };
  if (!response) return { kind, body: { success: false, "error-codes": ["missing-input-response"] } };
  if (kind === "fail") return { kind, body: { success: false, "error-codes": ["invalid-input-response"] } };
  if (kind === "spent") return { kind, body: { success: false, "error-codes": ["timeout-or-duplicate"] } };
  // Test secrets accept only the dummy token the test sitekeys produce.
  if (response !== DUMMY_TOKEN) return { kind, body: { success: false, "error-codes": ["invalid-input-response"] } };
  return { kind, body: { success: true, "error-codes": [], hostname: "localhost", challenge_ts: new Date().toISOString() } };
}

export class SiteverifyStub {
  readonly calls: SiteverifyCall[] = [];
  private constructor(private readonly server: Server, readonly url: string) {}

  static async start(): Promise<SiteverifyStub> {
    let stub: SiteverifyStub | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          if (req.method !== "POST" || !req.url?.endsWith("/siteverify")) {
            res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ success: false, "error-codes": ["bad-request"] }));
            return;
          }
          // siteverify takes a form (multipart or urlencoded) or JSON, as the docs list.
          const type = String(req.headers["content-type"] ?? "");
          const body = Buffer.concat(chunks);
          let get: (k: string) => string | null;
          try {
            if (type.includes("application/json")) {
              const o = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
              get = (k) => (typeof o[k] === "string" ? (o[k] as string) : null);
            } else {
              const form = await new Response(body, { headers: { "content-type": type } }).formData();
              get = (k) => { const v = form.get(k); return typeof v === "string" ? v : null; };
            }
          } catch {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ success: false, "error-codes": ["bad-request"] }));
            return;
          }
          const { kind, body: answer } = answerFor(get("secret"), get("response"));
          stub!.calls.push({ secretKind: kind, response: get("response"), remoteip: get("remoteip"), idempotencyKey: get("idempotency_key") });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        })();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const { port } = server.address() as AddressInfo;
    stub = new SiteverifyStub(server, `http://127.0.0.1:${port}/turnstile/v0/siteverify`);
    return stub;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
