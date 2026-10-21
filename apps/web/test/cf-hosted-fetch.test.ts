// The hosted fetch (track cf5-web; docs/cloudflare/design.md 3.4 and 6.2): the 428 human check and its single retry,
// the lease gate answers, and x-weft-tables recorded for the change feed.
import { afterEach, describe, expect, it } from "vitest";
import { createHostedFetch, gateCode, type HostedFetchDeps } from "../src/lib/hosted/fetch";
import { clearTables, tablesFor } from "../src/lib/api/poll";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function harness(answers: Response[], grant: () => Promise<void> = async () => {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const events: string[] = [];
  const deps: HostedFetchDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return answers.shift() ?? json(500, {}); }) as typeof fetch,
    ensureHumanGrant: async () => { events.push("grant"); await grant(); },
    markEnded: (r) => { events.push(`ended:${r}`); },
    requestStart: (r) => { events.push(`start:${r}`); },
    refreshSession: async () => { events.push("session"); },
  };
  return { f: createHostedFetch(() => deps), calls, events };
}

afterEach(() => clearTables());

describe("hosted fetch", () => {
  it("runs the human check on a mutation's 428 and retries it once with the same body", async () => {
    const h = harness([json(428, { _tag: "Forbidden", code: "TURNSTILE_REQUIRED", message: "check" }), json(200, { ok: true })]);
    const res = await h.f("/api/v1/agent/runs", { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(res.status).toBe(200);
    expect(h.events).toEqual(["grant"]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.init?.body).toBe(JSON.stringify({ text: "hi" }));
    expect(h.calls.every((c) => c.init?.credentials === "same-origin")).toBe(true);
  });

  it("retries only once, and returns the 428 when the check is cancelled", async () => {
    const twice = harness([json(428, { code: "TURNSTILE_REQUIRED" }), json(428, { code: "TURNSTILE_REQUIRED" })]);
    expect((await twice.f("/api/v1/x", { method: "PUT", body: "{}" })).status).toBe(428);
    expect(twice.calls).toHaveLength(2);
    const cancelled = harness([json(428, { code: "TURNSTILE_REQUIRED" })], async () => { throw new Error("cancelled"); });
    const res = await cancelled.f("/api/v1/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe("TURNSTILE_REQUIRED");   // the caller still reads the body
    expect(cancelled.calls).toHaveLength(1);
  });

  it("runs the check for a GET the edge gates as a mutation (a PDF render)", async () => {
    const h = harness([json(428, { code: "TURNSTILE_REQUIRED" }), new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } })]);
    expect((await h.f("/api/_hosted/pdf/pay_stub/pck_1")).status).toBe(200);
    expect(h.events).toEqual(["grant"]);
    expect(h.calls).toHaveLength(2);
  });

  it("leaves a 428 with another code alone", async () => {
    const h = harness([json(428, { code: "SOMETHING_ELSE" })]);
    expect((await h.f("/api/v1/x", { method: "POST", body: "{}" })).status).toBe(428);
    expect(h.events).toEqual([]);
  });

  it("offers Start my demo company on LEASE_REQUIRED and the ended screen on LEASE_ENDED", async () => {
    const a = harness([json(409, { _tag: "Conflict", code: "LEASE_REQUIRED", message: "read only" })]);
    expect((await a.f("/api/v1/proposals/p/approve", { method: "POST" })).status).toBe(409);
    expect(a.events).toEqual(["start:mutation"]);
    const b = harness([json(409, { _tag: "Conflict", code: "LEASE_ENDED", message: "old generation" })]);
    await b.f("/api/v1/workers");
    expect(b.events).toEqual(["ended:server"]);
    const c = harness([json(401, { _tag: "Unauthorized", code: "SESSION_INVALID", message: "bad cookie" })]);
    await c.f("/api/v1/workers");
    expect(c.events).toEqual(["session"]);
    const d = harness([json(409, { _tag: "Conflict", code: "NOT_PENDING", message: "decided" })]);
    await d.f("/api/v1/proposals/p/approve", { method: "POST" });
    expect(d.events).toEqual([]);
  });

  it("records x-weft-tables from GET responses, and null when they do not say", async () => {
    const h = harness([json(200, [], { "x-weft-tables": "proposals,proposal_votes" }), json(200, {})]);
    await h.f("/api/v1/proposals?status=pending");
    await h.f("/api/v1/sim/clock");
    expect([...(tablesFor("/api/v1/proposals?status=pending") ?? [])]).toEqual(["proposals", "proposal_votes"]);
    expect(tablesFor("/api/v1/sim/clock")).toBeNull();
  });

  it("gateCode reads the code from a clone and ignores other statuses", async () => {
    expect(await gateCode(json(428, { code: "TURNSTILE_REQUIRED" }))).toBe("TURNSTILE_REQUIRED");
    expect(await gateCode(json(200, { code: "TURNSTILE_REQUIRED" }))).toBeNull();
    expect(await gateCode(new Response("not json", { status: 409 }))).toBeNull();
  });
});
