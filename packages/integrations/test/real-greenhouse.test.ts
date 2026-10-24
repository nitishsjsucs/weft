// Real Harvest v3 adapter (w3-integrations-hr) on a fake transport only: no network, fictional values. Client
// credentials with a cached token, the Link cursor sent alone, 429 with Retry-After, one refresh on 401, the
// empty-offers permission gap, webhook signatures with the webhook secret, and no secret value in any error.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { AtsConnector } from "@weft/contracts";
import { createRealGreenhouse, GREENHOUSE_TOKEN_URL, type HttpResponse, type Transport } from "../src/real/greenhouse";

const dir = mkdtempSync(join(tmpdir(), "weft-gh-real-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SECRET = "fake-client-secret-never-printed-5512";
const HOOK = "fake-webhook-key-0042";
function envWith(lines: string[]) {
  const f = join(dir, `s-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(f, lines.join("\n"));
  return { WEFT_SECRETS_FILE: f };
}
const fullEnv = () => envWith(["WEFT_GREENHOUSE_CLIENT_ID=fake-client-id-77", `WEFT_GREENHOUSE_CLIENT_SECRET=${SECRET}`, `WEFT_GREENHOUSE_WEBHOOK_SECRET=${HOOK}`]);
const sim = {} as AtsConnector;
const json = (body: unknown, headers: Record<string, string> = {}, status = 200): HttpResponse => ({ status, headers: { "content-type": "application/json", ...headers }, text: JSON.stringify(body) });

const APP = { id: 6_600_101, candidate_id: 5_500_101, job_id: 4_400_103, status: "hired", updated_at: "2026-10-26T15:30:00.000Z" };
const OFFER = { id: 7_700_101, version: 1, status: "Accepted", starts_on: "2026-11-16", resolved_at: "2026-10-26T15:30:00.000Z", custom_fields: { salary: { amount: 132_000, unit: "USD" } } };
const CAND = { id: 5_500_101, first_name: "Marisol", last_name: "Quint", email_addresses: [{ value: "marisol.quint@candidate.example", type: "personal" }] };
const JOB = { id: 4_400_103, name: "Firmware Test Engineer", updated_at: "2026-10-20T16:00:00.000Z", departments: [{ id: 3_300_102, name: "Hardware" }], offices: [{ id: 2_200_109, name: "Boulder Field Office", location: { name: "Boulder, CO" } }] };

function fakeHarvest(over: Partial<Record<string, (url: URL, n: number) => HttpResponse>> = {}) {
  const calls: { url: string; auth: string }[] = [];
  let tokens = 0;
  const count: Record<string, number> = {};
  const t: Transport = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization ?? "" });
    if (url === GREENHOUSE_TOKEN_URL) { tokens++; return json({ access_token: `jwt-${tokens}`, token_type: "Bearer", expires_in: 3600 }); }
    const u = new URL(url);
    count[u.pathname] = (count[u.pathname] ?? 0) + 1;
    const o = over[u.pathname];
    if (o) return o(u, count[u.pathname]!);
    if (u.pathname === "/v3/applications") return json([APP], { "x-ratelimit-remaining": "74", "x-ratelimit-reset": "1793028630" });
    if (u.pathname === "/v3/offers") return json([OFFER]);
    if (u.pathname === "/v3/candidates") return json([CAND]);
    if (u.pathname === "/v3/jobs") return json([JOB]);
    return json({ message: "Not found" }, {}, 404);
  };
  return { t, calls, tokens: () => tokens };
}

describe("real Greenhouse adapter (fake transport)", () => {
  it("is absent without both client secrets", () => {
    expect(createRealGreenhouse(envWith(["WEFT_GREENHOUSE_CLIENT_ID=only-the-id"]), sim, { transport: fakeHarvest().t })).toBeNull();
    expect(createRealGreenhouse({}, sim)).toBeNull();
  });

  it("gets a client-credentials token once, caches it, and normalizes a hire like the simulator", async () => {
    const f = fakeHarvest();
    let now = Date.parse("2026-10-26T15:30:00.000Z");
    const gh = createRealGreenhouse(fullEnv(), sim, { transport: f.t, nowMs: () => now })!;
    const page = await gh.listHires({ updatedAfter: "2026-10-01T00:00:00.000Z", cursor: null });
    expect(page.items).toEqual([{ applicationId: "6600101", candidateId: "5500101", offerId: "7700101", offerVersion: 1, first: "Marisol", last: "Quint", email: "marisol.quint@candidate.example", jobName: "Firmware Test Engineer", departmentExtId: "3300102", officeExtId: "2200109", startDate: "2026-11-16", salary: { amountMinor: 13_200_000, currency: "USD" }, hiredAt: "2026-10-26T15:30:00.000Z" }]);
    expect(page.rateLimit.remaining).toBe(74);
    const tokenCall = f.calls.find((c) => c.url === GREENHOUSE_TOKEN_URL)!;
    expect(tokenCall.auth).toBe(`Basic ${Buffer.from(`fake-client-id-77:${SECRET}`).toString("base64")}`);
    expect(f.calls.filter((c) => c.url !== GREENHOUSE_TOKEN_URL).every((c) => c.auth === "Bearer jwt-1")).toBe(true);
    expect(new URL(f.calls[1]!.url).searchParams.get("updated_at[gt]")).toBe("2026-10-01T00:00:00.000Z");
    await gh.getHire("6600101");
    expect(f.tokens()).toBe(1);
    now += 3_600_000;   // past expires_in minus the 60-second margin
    await gh.getHire("6600101");
    expect(f.tokens()).toBe(2);
  });

  it("sends the Link cursor as the only query parameter and reads the next one", async () => {
    const f = fakeHarvest({ "/v3/applications": (u) => (u.searchParams.has("cursor")
      ? json([], {})
      : json([APP], { link: '<https://harvest.greenhouse.io/v3/applications?cursor=b3BhcXVl>; rel="next"' })) });
    const gh = createRealGreenhouse(fullEnv(), sim, { transport: f.t })!;
    const first = await gh.listHires({ updatedAfter: null, cursor: null });
    expect(first.nextCursor).toBe("b3BhcXVl");
    const second = await gh.listHires({ updatedAfter: "2026-10-01T00:00:00.000Z", cursor: first.nextCursor });
    expect(second).toMatchObject({ items: [], nextCursor: null });
    const last = new URL(f.calls.filter((c) => c.url.includes("/v3/applications")).at(-1)!.url);
    expect([...last.searchParams.keys()]).toEqual(["cursor"]);
  });

  it("waits Retry-After on a 429 and refreshes the token once on a 401", async () => {
    const slept: number[] = [];
    const f = fakeHarvest({ "/v3/jobs": (_u, n) => (n === 1 ? json({ message: "Rate limit exceeded" }, { "retry-after": "3" }, 429) : n === 2 ? json({ message: "expired" }, {}, 401) : json([JOB])) });
    const gh = createRealGreenhouse(fullEnv(), sim, { transport: f.t, sleep: async (ms) => { slept.push(ms); } })!;
    const jobs = await gh.listJobs({ cursor: null, source: "harvest" });
    expect(jobs.items.map((j) => j.name)).toEqual(["Firmware Test Engineer"]);
    expect(slept).toEqual([3000]);
    expect(f.tokens()).toBe(2);
  });

  it("reports the empty-offers permission gap and an auth failure without any secret in the detail", async () => {
    const gap = createRealGreenhouse(fullEnv(), sim, { transport: fakeHarvest({ "/v3/offers": () => json([]) }).t })!;
    expect(await gap.testConnection()).toMatchObject({ mode: "real", configured: true, health: "permission_gap", detail: "offers_hidden_by_permissions" });
    const denied: Transport = async (url) => (url === GREENHOUSE_TOKEN_URL ? json({ error: "invalid_client" }, {}, 401) : json([]));
    const bad = createRealGreenhouse(fullEnv(), sim, { transport: denied })!;
    const s = await bad.testConnection();
    expect(s).toMatchObject({ health: "auth_failed", detail: "http_401" });
    expect(JSON.stringify(s)).not.toContain(SECRET);
    await expect(bad.listHires({ updatedAfter: null, cursor: null })).rejects.toThrow(/^greenhouse \/token: HTTP 401$/);
    await expect(bad.markHired({ applicationId: "1", startDate: "2026-11-16", credential: "x" })).rejects.toThrow(/read-only/);
  });

  it("verifies webhooks with the webhook secret over the raw bytes; a re-serialized body or no secret fails", () => {
    const gh = createRealGreenhouse(fullEnv(), sim, { transport: fakeHarvest().t })!;
    const raw = '{"action":"hire_candidate","payload":{"application":{"id":6600101,"note":"\\u003cb\\u003e"}}}';
    const sig = `sha256 ${createHmac("sha256", HOOK).update(raw).digest("hex")}`;
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(gh.verifyWebhook(enc(raw), { Signature: sig, "Greenhouse-Event-ID": "evt-1" })).toEqual({ ok: true, dedupeKey: "evt-1" });
    expect(gh.verifyWebhook(enc(JSON.stringify(JSON.parse(raw))), { Signature: sig, "Greenhouse-Event-ID": "evt-1" }).ok).toBe(false);
    expect(gh.parseWebhook(enc(raw))).toEqual({ action: "hire_candidate", applicationId: "6600101" });
    const noHook = createRealGreenhouse(envWith(["WEFT_GREENHOUSE_CLIENT_ID=id", `WEFT_GREENHOUSE_CLIENT_SECRET=${SECRET}`]), sim, { transport: fakeHarvest().t })!;
    expect(noHook.verifyWebhook(enc(raw), { Signature: sig, "Greenhouse-Event-ID": "evt-1" }).ok).toBe(false);
  });
});
