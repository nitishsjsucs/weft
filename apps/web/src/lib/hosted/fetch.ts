// The hosted build's fetch for /api (docs/cloudflare/design.md 3.4 and 6.2). It records each GET's `x-weft-tables`
// for the change feed, and handles the front Worker's gate answers:
// - 428 TURNSTILE_REQUIRED: run the human check (usually without interaction), then retry once. Mutations get it,
//   and so may a GET the edge treats as one (a PDF render);
// - 409 LEASE_REQUIRED (a mutation on the shared showcase): offer "Open my workspace";
// - 409 LEASE_ENDED (the cookie's generation is older than the world's): show the lease-ended screen;
// - 401 SESSION_INVALID: re-read the session;
// - 429 DEMO_LIMIT and 503 SHOWCASE_LIMIT (the world's rows budget, design 6.3): the banner says the workspace has
//   used its activity limit (or the shared one its daily limit).
// The response the caller sees is the retried one, or the original when the check was cancelled. The lease and
// session answers are acted on whichever response carries them, the first or the retried one.
import { TABLES_HEADER, type HostedErrorCode } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { recordTables } from "../api/poll";
import { ensureHumanGrant, markEnded, markLimited, refreshSession, requestStart } from "./session";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
}

/** The hosted error code of a gate answer, read from a clone (the caller still reads the body). */
export async function gateCode(res: Response): Promise<HostedErrorCode | null> {
  if (res.status !== 428 && res.status !== 409 && res.status !== 401 && res.status !== 429 && res.status !== 503) return null;
  try { const b = (await res.clone().json()) as { code?: unknown }; return typeof b.code === "string" ? (b.code as HostedErrorCode) : null; }
  catch { return null; }
}

export interface HostedFetchDeps {
  fetch: typeof fetch;
  ensureHumanGrant: () => Promise<void>;
  markEnded: typeof markEnded;
  requestStart: typeof requestStart;
  refreshSession: () => Promise<unknown>;
  markLimited?: typeof markLimited;
}
const defaultDeps = (): HostedFetchDeps => ({ fetch: (...a) => fetch(...a), ensureHumanGrant, markEnded, requestStart, refreshSession, markLimited });

/** Builds a hosted fetch over `deps` (tests pass fakes). */
export function createHostedFetch(deps: () => HostedFetchDeps = defaultDeps): typeof fetch {
  return async function hostedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const d = deps();
    const method = methodOf(input, init);
    const send = () => d.fetch(input, { credentials: "same-origin", ...init });
    let res = await send();
    let code = await gateCode(res);
    if (res.status === 428 && code === "TURNSTILE_REQUIRED") {
      try { await d.ensureHumanGrant(); } catch { return res; }
      res = await send();
      code = await gateCode(res);
    }
    if (code === "LEASE_REQUIRED") {
      d.requestStart("mutation");
    } else if (code === "LEASE_ENDED") {
      d.markEnded("server");
    } else if (code === "SESSION_INVALID") {
      void d.refreshSession();
    } else if (code === "DEMO_LIMIT" || code === "SHOWCASE_LIMIT") {
      d.markLimited?.(code === "DEMO_LIMIT" ? "demo" : "showcase");
    }
    if (method === "GET" && res.ok) recordTables(urlOf(input), res.headers.get(TABLES_HEADER));
    return res;
  };
}

export const hostedFetch: typeof fetch = createHostedFetch();
