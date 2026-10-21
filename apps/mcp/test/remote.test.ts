// The remote MCP handler (docs/cloudflare/design.md 3.3 and 6.3; tracks.md cf3-agent): the official SDK client over
// Streamable HTTP against createRemoteMcpHandler, whose fetchImpl calls a seeded Weft's Hono app in process (as the
// slot Durable Object does). It lists the same 122 tools as stdio, refuses approve, rollback and vault, and agent_ask
// makes at most 3 requests per call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "../../api/src/testing";
import type { WeftAgentRuntime } from "../../../packages/agent/src/index";
import { MCP_AGENT_ASK_PER_KEY_DAY, RUN_LONG_POLL_MAX_S } from "../../../packages/contracts/src/ext/cf-agent";
import { createMcpServer, keyTag, mcpKeyOf, memoryAskLimiter, stateAskLimiter } from "../src/index";
import { Client, createRemoteMcpHandler, InMemoryTransport, StreamableHTTPClientTransport } from "../src/testing";

let weft: TestWeft;
let mcpKey: string;
beforeAll(async () => {
  weft = await createTestWeft();
  mcpKey = readFileSync(join(weft.dataDir, "demo-mcp-key.txt"), "utf8").trim();
}, 120_000);
afterAll(async () => { await weft?.close(); });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The in-process API, as CompanyDO hands it to the handler; it records every request the handler makes. */
function api(log: string[] = []): Fetch {
  return async (url, init) => {
    log.push(`${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`);
    return weft.app.request(new URL(url).pathname + new URL(url).search, init);
  };
}

/** An SDK client whose fetch goes straight into the handler (no socket). */
async function remoteClient(handler: (req: Request) => Promise<Response>, headers: Record<string, string> = { authorization: `Bearer ${mcpKey}` }) {
  const transport = new StreamableHTTPClientTransport(new URL("https://weft.example/mcp"), {
    fetch: (url, init) => handler(new Request(url, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: "remote-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content).map((c) => c.text).join("\n");

describe("createRemoteMcpHandler", () => {
  it("acceptance: lists the same 122 tools as the stdio server, read and propose only", async () => {
    const client = await remoteClient(createRemoteMcpHandler({}, api()));
    try {
      expect(client.getInstructions()).toMatch(/fictional/);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(122);
      const names = tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["tax__update_rate", "notices__get", "people__search", "memory__search", "agent_ask"]));
      for (const n of names) expect(n).not.toMatch(/approve|deny|rollback|vault|settings|api_key|write_note|routines__enable/);
      // The stdio server over the same app lists exactly the same tools.
      const stdio = createMcpServer({ apiUrl: "http://127.0.0.1:4070", apiKey: mcpKey }, (u, i) => Promise.resolve(weft.app.request(u, i)));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await stdio.connect(st);
      const local = new Client({ name: "stdio-test", version: "0.0.0" });
      await local.connect(ct);
      expect((await local.listTools()).tools).toEqual(tools);
      await local.close();
    } finally {
      await client.close();
    }
  });

  it("acceptance: approve, rollback and vault are refused, and tax__update_rate returns pending_approval", async () => {
    const log: string[] = [];
    const client = await remoteClient(createRemoteMcpHandler({}, api(log)));
    try {
      for (const name of ["proposals__approve", "proposals__deny", "actions__rollback", "vault__get", "vault__list"]) {
        const r = await client.callTool({ name, arguments: {} });
        expect(r.isError, name).toBe(true);
        expect(text(r)).toBe(`${name} is not exposed over MCP`);
      }
      // None of them reached the API.
      expect(log.filter((l) => l.startsWith("POST /v1/tools/"))).toEqual([]);
      const notice = await client.callTool({ name: "notices__get", arguments: { notice_id: "ntc_0001", response_format: "detailed" } });
      expect(notice.isError).toBe(false);
      expect(text(notice)).toContain("<untrusted n=");
    } finally {
      await client.close();
    }
  });

  it("acceptance: agent_ask makes at most 3 requests per call: the POST and two long polls", async () => {
    // An API whose run never finishes: the handler stops after its third request.
    const log: string[] = [];
    const stuck: Fetch = async (url, init) => {
      const u = new URL(url);
      log.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
      if (init?.method === "POST") return Response.json({ runId: "run_0042", chatMode: "read" }, { status: 202 });
      return Response.json({ id: "run_0042", status: "running" });
    };
    const client = await remoteClient(createRemoteMcpHandler({ askLimiter: null }, stuck));
    try {
      const r = await client.callTool({ name: "agent_ask", arguments: { question: "How many people work here?" } });
      expect(JSON.parse(text(r))).toEqual({ runId: "run_0042", status: "still running" });
      expect(log).toEqual(["POST /v1/agent/runs", `GET /v1/agent/runs/run_0042?wait=${RUN_LONG_POLL_MAX_S}`, `GET /v1/agent/runs/run_0042?wait=${RUN_LONG_POLL_MAX_S}`]);
    } finally {
      await client.close();
    }
  });

  it("agent_ask on the real app: one long poll returns the settled run (the long poll is emulated by waiting for it)", async () => {
    const log: string[] = [];
    const runtime = weft.agent as WeftAgentRuntime;
    // GET ?wait=25 (cf2-platform's additive long poll) waits until the run leaves queued and running; emulated here.
    const longPoll: Fetch = async (url, init) => {
      const u = new URL(url);
      log.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
      const id = /^\/v1\/agent\/runs\/(run_[A-Za-z0-9_]+)$/.exec(u.pathname)?.[1];
      if (id && u.searchParams.get("wait")) await runtime.settled(id);
      return weft.app.request(u.pathname + u.search, init);
    };
    const client = await remoteClient(createRemoteMcpHandler({ askLimiter: null }, longPoll));
    try {
      const r = await client.callTool({ name: "agent_ask", arguments: { question: "Who is on leave next week?" } });
      expect(r.isError).toBe(false);
      const run = JSON.parse(text(r)) as { id: string; status: string; provider: string };
      expect(run.status).not.toMatch(/^(queued|running)$/);
      expect(run.provider).toBe("scripted");
      expect(log.filter((l) => l.includes("/v1/agent/runs"))).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("agent_ask is limited per key per UTC day; other tools are not", async () => {
    const stuck: Fetch = async (_url, init) => (init?.method === "POST" ? Response.json({ runId: "run_0043" }, { status: 202 }) : Response.json({ id: "run_0043", status: "done" }));
    let now = new Date("2026-10-26T10:00:00Z");
    const client = await remoteClient(createRemoteMcpHandler({ askLimiter: memoryAskLimiter(MCP_AGENT_ASK_PER_KEY_DAY, () => now) }, stuck));
    try {
      for (let i = 0; i < MCP_AGENT_ASK_PER_KEY_DAY; i++) expect((await client.callTool({ name: "agent_ask", arguments: { question: `q${i}` } })).isError).toBe(false);
      const sixth = await client.callTool({ name: "agent_ask", arguments: { question: "one more" } });
      expect(sixth.isError).toBe(true);
      expect(text(sixth)).toMatch(/limited to 5 runs per key per day/);
      now = new Date("2026-10-27T00:00:01Z");
      expect((await client.callTool({ name: "agent_ask", arguments: { question: "next day" } })).isError).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("stateAskLimiter keeps counts in the world's small state under a key tag, never the key", async () => {
    const state = new Map<string, string>();
    const lim = stateAskLimiter({ get: (k) => state.get(k) ?? null, set: (k, v) => { state.set(k, v); } }, 2, () => new Date("2026-10-26T10:00:00Z"));
    expect(await lim.take("wk_mcp_slot-1_3_abcdefabcdefabcdef")).toEqual({ ok: true });
    expect(await lim.take("wk_mcp_slot-1_3_abcdefabcdefabcdef")).toEqual({ ok: true });
    expect(await lim.take("wk_mcp_slot-1_3_abcdefabcdefabcdef")).toEqual({ ok: false, limit: 2 });
    expect(await lim.take("wk_mcp_slot-1_3_other0000000000000")).toEqual({ ok: true });
    const tag = await keyTag("wk_mcp_slot-1_3_abcdefabcdefabcdef");
    expect([...state.keys()]).toContain(`mcp.ask.${tag}.2026-10-26`);
    expect(JSON.stringify([...state])).not.toContain("abcdefabcdef");
  });

  it("refuses a request without a key (401), and GET or DELETE (405, stateless: no SSE stream, no session)", async () => {
    const handler = createRemoteMcpHandler({}, api());
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const post = (headers: Record<string, string>) => handler(new Request("https://weft.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) }));
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expect(await none.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32001 } });
    for (const method of ["GET", "DELETE"]) {
      const r = await handler(new Request("https://weft.example/mcp", { method, headers: { authorization: `Bearer ${mcpKey}` } }));
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
    // x-api-key works too, and the answer is JSON (no SSE stream holds the object open).
    const ok = await post({ "x-api-key": mcpKey });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/application\/json/);
    expect(await ok.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "weft" } } });
  });

  it("memoizes the tool listing per key (it is the registry's), and never a refused listing", async () => {
    const log: string[] = [];
    let t = 0;
    const handler = createRemoteMcpHandler({ now: () => t }, api(log));
    const a = await remoteClient(handler);
    const b = await remoteClient(handler);
    try {
      const first = (await a.listTools()).tools;
      expect((await b.listTools()).tools).toEqual(first);
      expect(log.filter((l) => l === "GET /v1/tools?surface=mcp")).toHaveLength(1);
      t = 60_000;
      await a.listTools();
      expect(log.filter((l) => l === "GET /v1/tools?surface=mcp")).toHaveLength(2);
      const off = createRemoteMcpHandler({ listCacheMs: 0 }, api(log));
      const c = await remoteClient(off);
      await c.listTools();
      await c.listTools();
      expect(log.filter((l) => l === "GET /v1/tools?surface=mcp")).toHaveLength(4);
      await c.close();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("an unknown or wrong-scope key reaches the API, which refuses it; the key never appears in a response", async () => {
    const client = await remoteClient(createRemoteMcpHandler({}, api()), { authorization: "Bearer wk_mcp_slot-1_1_notarealkey0000000000" });
    try {
      await expect(client.listTools()).rejects.toThrow(/GET \/v1\/tools failed with 40[13]/);
    } finally {
      await client.close();
    }
  });

  it("an Origin outside the allowed list is refused; machine clients send none", async () => {
    const handler = createRemoteMcpHandler({ allowedOrigins: ["https://weft.nitish-ratakonda.workers.dev"] }, api());
    const r = await handler(new Request("https://weft.example/mcp", { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${mcpKey}`, "content-type": "application/json" }, body: "{}" }));
    expect(r.status).toBe(403);
  });

  it("mcpKeyOf reads Bearer first, then x-api-key", () => {
    expect(mcpKeyOf(new Request("https://x/mcp", { headers: { authorization: "Bearer abc", "x-api-key": "def" } }))).toBe("abc");
    expect(mcpKeyOf(new Request("https://x/mcp", { headers: { "x-api-key": " def " } }))).toBe("def");
    expect(mcpKeyOf(new Request("https://x/mcp", { headers: { authorization: "Basic abc" } }))).toBeNull();
  });
});
