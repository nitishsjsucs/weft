// A local stand-in for Turnstile's siteverify (docs/cloudflare/design.md 11.4 and 11.5), track cf7-integrate. The local
// stack's front Worker reaches it through `pnpm cf:dev --turnstile-verify-url http://localhost:5809/turnstile/v0/siteverify`,
// so a lease started in the browser with Cloudflare's test sitekey is verified without the network (workerd does not
// use an HTTPS proxy). It answers with Cloudflare's published test-secret semantics
// (developers.cloudflare.com/turnstile/troubleshooting/testing/):
//
//   1x0000000000000000000000000000000AA  always passes, for the dummy token the test sitekeys produce
//   2x0000000000000000000000000000000AA  always fails (invalid-input-response)
//   3x0000000000000000000000000000000AA  always fails as already spent (timeout-or-duplicate)
//
// Any other secret is refused as invalid-input-secret, so a production secret can never pass here; a missing secret or
// token is missing-input-*. GET /health answers 200 and GET /calls lists what the front sent (the secret's kind, never
// the secret itself, whether the token was the dummy, and whether remoteip and idempotency_key were present).
//
//   node_modules/.bin/tsx e2e/cf/siteverify-stub.ts [--port 5809]
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const TEST_SECRETS = {
  pass: "1x0000000000000000000000000000000AA",
  fail: "2x0000000000000000000000000000000AA",
  spent: "3x0000000000000000000000000000000AA",
} as const;
/** What Cloudflare's test sitekeys hand the page instead of a real token. */
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
export const SITEVERIFY_PATH = "/turnstile/v0/siteverify";

export type SecretKind = "pass" | "fail" | "spent" | "other" | "missing";
export interface StubCall { at: string; secretKind: SecretKind; dummyToken: boolean; remoteip: boolean; idempotencyKey: boolean; success: boolean; codes: string[] }
export interface StubAnswer { success: boolean; "error-codes": string[]; hostname?: string; challenge_ts?: string }

export function answer(secret: string | null, response: string | null): { kind: SecretKind; body: StubAnswer } {
  if (!secret) return { kind: "missing", body: { success: false, "error-codes": ["missing-input-secret"] } };
  const kind: SecretKind = secret === TEST_SECRETS.pass ? "pass" : secret === TEST_SECRETS.fail ? "fail" : secret === TEST_SECRETS.spent ? "spent" : "other";
  if (kind === "other") return { kind, body: { success: false, "error-codes": ["invalid-input-secret"] } };
  if (!response) return { kind, body: { success: false, "error-codes": ["missing-input-response"] } };
  if (kind === "fail") return { kind, body: { success: false, "error-codes": ["invalid-input-response"] } };
  if (kind === "spent") return { kind, body: { success: false, "error-codes": ["timeout-or-duplicate"] } };
  if (response !== DUMMY_TOKEN) return { kind, body: { success: false, "error-codes": ["invalid-input-response"] } };
  return { kind, body: { success: true, "error-codes": [], hostname: "localhost", challenge_ts: new Date().toISOString() } };
}

const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function fields(req: IncomingMessage, body: Buffer): Promise<(k: string) => string | null> {
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    const o = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    return (k) => (typeof o[k] === "string" ? (o[k] as string) : null);
  }
  // multipart/form-data (what the front sends) or application/x-www-form-urlencoded
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
  return (k) => { const v = form.get(k); return typeof v === "string" ? v : null; };
}

export function stubHandler(calls: StubCall[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
        if (req.method === "GET" && path === "/calls") return send(res, 200, { calls });
        if (req.method !== "POST" || path !== SITEVERIFY_PATH) return send(res, 404, { success: false, "error-codes": ["bad-request"] });
        let get: (k: string) => string | null;
        try { get = await fields(req, Buffer.concat(chunks)); } catch { return send(res, 400, { success: false, "error-codes": ["bad-request"] }); }
        const { kind, body } = answer(get("secret"), get("response"));
        calls.push({ at: new Date().toISOString(), secretKind: kind, dummyToken: get("response") === DUMMY_TOKEN, remoteip: !!get("remoteip"), idempotencyKey: !!get("idempotency_key"), success: body.success, codes: body["error-codes"] });
        if (calls.length > 500) calls.splice(0, calls.length - 500);
        send(res, 200, body);
      })();
    });
  };
}

/** Listens on both loopback addresses (workerd and the browser may resolve localhost to either), never 0.0.0.0. */
export async function startStub(port: number): Promise<{ servers: Server[]; calls: StubCall[]; close(): Promise<void> }> {
  const calls: StubCall[] = [];
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const s = createServer(stubHandler(calls));
    try {
      await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(port, host, () => resolve()); });
      servers.push(s);
    } catch (e) {
      // A machine without IPv6 loopback still gets the IPv4 listener; a port in use fails the start.
      if (host === "::1" && (e as NodeJS.ErrnoException).code === "EADDRNOTAVAIL") continue;
      for (const x of servers) x.close();
      throw e;
    }
  }
  return {
    servers, calls,
    close: async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); },
  };
}

async function main(argv: string[]): Promise<void> {
  const i = argv.indexOf("--port");
  const port = Number(i >= 0 ? argv[i + 1] : 5809);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`--port ${argv[i + 1]} is not a port`);
  const stub = await startStub(port);
  console.log(`siteverify stub on http://localhost:${port}${SITEVERIFY_PATH} (test secrets only)`);
  const stop = () => { void stub.close().then(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(`siteverify stub: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
