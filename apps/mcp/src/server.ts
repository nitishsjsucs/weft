// The MCP server (SPEC 9.8). Owner: t3-governance; the remote ask mode is Weft on Cloudflare (track cf3-agent). A thin
// client of GET/POST /v1/tools with the mcp-scope key: it registers every read and propose tool from
// /v1/tools?surface=mcp plus agent_ask, and never exposes approve, deny, rollback, vault, settings or memory writes
// (the API never lists them for an mcp key, and this server drops anything that is not read or propose).
// Portable: no node: imports, so the stdio server (main.ts) and the remote handler (remote.ts) share it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpConfig { apiUrl: string; apiKey: string }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SERVER_INSTRUCTIONS =
  "Weft runs on synthetic data for a fictional company (Larkspur Robotics). Every person, agency, bank and carrier is simulated. " +
  "Write tools only create proposals that a human approves in the Weft app.";

export const NEVER_EXPOSED = /^(proposals|actions__rollback|vault__|settings|api_keys|memory__write|routines__enable|routines__disable)/;

interface Listing { name: string; description: string; parameters: Record<string, unknown>; mcp: string; effect: string }

const AGENT_ASK = {
  name: "agent_ask",
  description: "Ask the Weft agent a question about the company. It answers from read-only tools; the run is marked as reading untrusted input.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

/** How agent_ask waits for its run. */
export type AgentAskMode =
  /** stdio: poll GET /v1/agent/runs/:id every 500 ms, up to 120 times (unchanged). */
  | { kind: "poll" }
  /** remote: at most `maxRequests` requests per call, the POST plus GET ?wait=<waitS> long polls (cf-agent.ts). */
  | { kind: "long_poll"; waitS: number; maxRequests: number };

/** May this key start another agent_ask run (MCP_AGENT_ASK_PER_KEY_DAY on hosted)? */
export interface AskLimiter { take(apiKey: string): Promise<{ ok: true } | { ok: false; limit: number }> }

export interface McpServerOptions {
  agentAsk?: AgentAskMode;
  askLimiter?: AskLimiter | null;
}

const ACTIVE = ["queued", "running"];

export function createMcpServer(cfg: McpConfig, fetchImpl: Fetch = (u, i) => fetch(u, i), opts: McpServerOptions = {}): Server {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetchImpl(`${cfg.apiUrl}${path}`, { ...init, headers: { "x-api-key": cfg.apiKey, "content-type": "application/json", ...(init.headers ?? {}) } });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body };
  };
  const ask = opts.agentAsk ?? { kind: "poll" };
  const server = new Server({ name: "weft", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { status, body } = await call("/v1/tools?surface=mcp");
    if (status !== 200 || !Array.isArray(body)) throw new Error(`GET /v1/tools failed with ${status}`);
    const tools = (body as Listing[])
      .filter((t) => (t.mcp === "read" || t.mcp === "propose") && !NEVER_EXPOSED.test(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" },
        annotations: { readOnlyHint: t.mcp === "read", destructiveHint: false, openWorldHint: false } }));
    return { tools: [...tools, AGENT_ASK] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "agent_ask") {
      const q = typeof args.question === "string" ? args.question : "";
      if (opts.askLimiter) {
        const allowed = await opts.askLimiter.take(cfg.apiKey);
        if (!allowed.ok) return { content: [{ type: "text", text: `agent_ask is limited to ${allowed.limit} runs per key per day on this workspace; try again after 00:00 UTC.` }], isError: true };
      }
      const start = await call("/v1/agent/runs", { method: "POST", body: JSON.stringify({ text: q, pageContext: null, threadId: null }) });
      if (start.status >= 300) return { content: [{ type: "text", text: JSON.stringify(start.body) }], isError: true };
      const runId = (start.body as { runId?: string }).runId;
      if (ask.kind === "long_poll") {
        // The POST was one request; each long poll waits up to waitS seconds for the run to leave queued and running.
        for (let i = 1; i < ask.maxRequests && runId; i++) {
          const run = await call(`/v1/agent/runs/${encodeURIComponent(runId)}?wait=${ask.waitS}`);
          const st = (run.body as { status?: string } | null)?.status;
          if (run.status >= 300) return { content: [{ type: "text", text: JSON.stringify(run.body) }], isError: true };
          if (st && !ACTIVE.includes(st)) return { content: [{ type: "text", text: JSON.stringify(run.body) }], isError: false };
        }
        return { content: [{ type: "text", text: JSON.stringify({ runId, status: "still running" }) }], isError: false };
      }
      for (let i = 0; i < 120 && runId; i++) {
        const run = await call(`/v1/agent/runs/${runId}`);
        const st = (run.body as { status?: string; summary?: string | null }).status;
        if (st && !ACTIVE.includes(st)) return { content: [{ type: "text", text: JSON.stringify(run.body) }], isError: false };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { content: [{ type: "text", text: JSON.stringify({ runId, status: "still running" }) }], isError: false };
    }
    if (NEVER_EXPOSED.test(name)) return { content: [{ type: "text", text: `${name} is not exposed over MCP` }], isError: true };
    const res = await call(`/v1/tools/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(args) });
    const ok = res.status < 300;
    return { content: [{ type: "text", text: typeof res.body === "string" ? res.body : JSON.stringify(res.body) }], isError: !ok };
  });
  return server;
}
