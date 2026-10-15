// MCP stdio server (SPEC 9.8). Owner: t3-governance. A thin client of GET/POST /v1/tools with the mcp-scope key.
// Reads WEFT_API_URL and WEFT_API_KEY; registers every read and propose tool from /v1/tools?surface=mcp plus
// agent_ask; never exposes approve, deny, rollback, vault, settings or memory writes (the API never lists them for
// an mcp key, and this server drops anything that is not read or propose).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpConfig { apiUrl: string; apiKey: string }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SERVER_INSTRUCTIONS =
  "Weft runs on synthetic data for a fictional company (Larkspur Robotics (demo)). Every person, agency, bank and carrier is simulated. " +
  "Write tools only create proposals that a human approves in the Weft app.";

export const NEVER_EXPOSED = /^(proposals|actions__rollback|vault__|settings|api_keys|memory__write|routines__enable|routines__disable)/;

export function readConfig(env: Record<string, string | undefined>): McpConfig {
  const apiUrl = env.WEFT_API_URL ?? "http://127.0.0.1:4070";
  const apiKey = env.WEFT_API_KEY ?? "";
  if (!apiKey) throw new Error("WEFT_API_KEY is required (the mcp-scope key from .data/demo-mcp-key.txt)");
  return { apiUrl, apiKey };
}

interface Listing { name: string; description: string; parameters: Record<string, unknown>; mcp: string; effect: string }

const AGENT_ASK = {
  name: "agent_ask",
  description: "Ask the Weft agent a question about the fictional company. It answers from read-only tools; the run is marked as reading untrusted input.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export function createMcpServer(cfg: McpConfig, fetchImpl: Fetch = (u, i) => fetch(u, i)): Server {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetchImpl(`${cfg.apiUrl}${path}`, { ...init, headers: { "x-api-key": cfg.apiKey, "content-type": "application/json", ...(init.headers ?? {}) } });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body };
  };
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
      const start = await call("/v1/agent/runs", { method: "POST", body: JSON.stringify({ text: q, pageContext: null, threadId: null }) });
      if (start.status >= 300) return { content: [{ type: "text", text: JSON.stringify(start.body) }], isError: true };
      const runId = (start.body as { runId?: string }).runId;
      for (let i = 0; i < 120 && runId; i++) {
        const run = await call(`/v1/agent/runs/${runId}`);
        const st = (run.body as { status?: string; summary?: string | null }).status;
        if (st && !["queued", "running"].includes(st)) return { content: [{ type: "text", text: JSON.stringify(run.body) }], isError: false };
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

export async function main(env = process.env): Promise<void> {
  const cfg = readConfig(env);
  const server = createMcpServer(cfg);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
