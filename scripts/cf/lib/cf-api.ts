// A small Cloudflare REST client for the cf scripts. The token comes from CLOUDFLARE_API_TOKEN, which only
// scripts/cf/with-cf.sh puts in a command's environment; it is sent as a bearer header and never logged. Error
// messages carry Cloudflare's error codes and messages, never request headers.
export interface CfApi {
  readonly accountId: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  /** POST to the GraphQL Analytics API. */
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export class CfApiError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) { super(message); }
}

export function cfApiFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): CfApi {
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !accountId) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set: run this through scripts/cf/with-cf.sh");
  return cfApi({ token, accountId, fetch: fetchImpl });
}

export function cfApi(o: { token: string; accountId: string; fetch: typeof fetch; base?: string }): CfApi {
  const base = o.base ?? "https://api.cloudflare.com/client/v4";
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const url = `${base}${path.replace(":account", encodeURIComponent(o.accountId))}`;
    const res = await o.fetch(url, {
      method,
      headers: { authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { success?: boolean; result?: T; errors?: { code: number; message: string }[]; data?: T } = {};
    try { parsed = JSON.parse(text) as typeof parsed; } catch { /* not JSON */ }
    if (!res.ok || parsed.success === false) {
      const errs = parsed.errors ?? [];
      throw new CfApiError(res.status, errs.map((e) => e.code), `${method} ${path} failed (${res.status}): ${errs.map((e) => `${e.code} ${e.message}`).join("; ") || text.slice(0, 200)}`);
    }
    return (parsed.result ?? parsed.data ?? (parsed as unknown)) as T;
  };
  return {
    accountId: o.accountId,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    async graphql(query, variables) {
      const res = await o.fetch(`${base}/graphql`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
      const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] | null };
      if (!res.ok || (body.errors && body.errors.length)) throw new CfApiError(res.status, [], `GraphQL failed (${res.status}): ${(body.errors ?? []).map((e) => e.message).join("; ")}`);
      return body.data as never;
    },
  };
}
