// MCP stdio server (SPEC 9.8). Owner: t3-governance. A thin client of GET/POST /v1/tools with the mcp-scope key.
// Reads WEFT_API_URL and WEFT_API_KEY (or WEFT_API_KEY_FILE, a path to the key file); registers every read and propose tool from /v1/tools?surface=mcp plus
// agent_ask; never exposes approve, deny, rollback, vault, settings or memory writes (the API never lists them for
// an mcp key, and this server drops anything that is not read or propose).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpConfig { apiUrl: string; apiKey: string }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SERVER_INSTRUCTIONS =
  "Weft runs on synthetic data for a fictional company (Larkspur Robotics (demo)). Every person, agency, bank and carrier is simulated. " +
  "Write tools only create proposals that a human approves in the Weft app.";

export const NEVER_EXPOSED = /^(proposals|actions__rollback|vault__|settings|api_keys|memory__write|routines__enable|routines__disable)/;

/**
 * WEFT_API_KEY is the mcp-scope key itself; WEFT_API_KEY_FILE names the file that holds it (the seed writes
 * <data dir>/demo-mcp-key.txt), so a client config can point at the file and never carry the key.
 */
export function readConfig(env: Record<string, string | undefined>, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): McpConfig {
  const apiUrl = env.WEFT_API_URL ?? "http://127.0.0.1:4070";
  let apiKey = env.WEFT_API_KEY ?? "";
  if (!apiKey && env.WEFT_API_KEY_FILE) {
    try { apiKey = readFile(env.WEFT_API_KEY_FILE).trim(); } catch { throw new Error(`WEFT_API_KEY_FILE ${env.WEFT_API_KEY_FILE} cannot be read; seed the world first (pnpm dev writes .data/demo-mcp-key.txt)`); }
  }
  if (!apiKey) throw new Error("WEFT_API_KEY or WEFT_API_KEY_FILE is required (the mcp-scope key in .data/demo-mcp-key.txt)");
  return { apiUrl, apiKey };
}

export interface ClientConfigOptions {
  /** Absolute path of the checkout (the directory with pnpm-workspace.yaml). */
  root: string;
  /** Data dir relative to root or absolute (default .data, the one pnpm dev uses). */
  dataDir?: string;
  apiPort?: number;
  /** The pnpm executable (an absolute path when the client starts with a short PATH, as desktop apps do). */
  pnpm?: string;
  /** Directories to put on the server's PATH: node's, so pnpm and tsx find it. */
  pathDirs?: string[];
}

/**
 * A ready-to-paste MCP client config (the `mcpServers` shape Claude Desktop, the MCP Inspector and most clients
 * read): stdio, `pnpm --dir <root> --filter @weft/mcp start`, the API URL and the key file. No cwd key (not every
 * client reads one) and no key value: the server reads WEFT_API_KEY_FILE.
 */
export function clientConfig(o: ClientConfigOptions): { mcpServers: { weft: { command: string; args: string[]; env: Record<string, string> } } } {
  const dataDir = o.dataDir ?? ".data";
  const keyFile = dataDir.startsWith("/") ? join(dataDir, "demo-mcp-key.txt") : join(o.root, dataDir, "demo-mcp-key.txt");
  const env: Record<string, string> = { WEFT_API_URL: `http://127.0.0.1:${o.apiPort ?? 4070}`, WEFT_API_KEY_FILE: keyFile };
  if (o.pathDirs?.length) env.PATH = [...new Set([...o.pathDirs, "/usr/bin", "/bin"])].join(":");
  return { mcpServers: { weft: { command: o.pnpm ?? "pnpm", args: ["--silent", "--dir", o.root, "--filter", "@weft/mcp", "start"], env } } };
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
