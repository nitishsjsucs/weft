// MCP stdio server (SPEC 9.8). Owner: t3-governance. A thin client of GET/POST /v1/tools with the mcp-scope key.
// Reads WEFT_API_URL and WEFT_API_KEY (or WEFT_API_KEY_FILE, a path to the key file); registers every read and propose tool from /v1/tools?surface=mcp plus
// agent_ask; never exposes approve, deny, rollback, vault, settings or memory writes (the API never lists them for
// an mcp key, and this server drops anything that is not read or propose).
// The server itself is server.ts (shared with the remote Streamable HTTP handler in remote.ts); this file is the stdio
// entry and the client config, the only parts that touch the file system.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type McpConfig } from "./server";

export { createMcpServer, NEVER_EXPOSED, SERVER_INSTRUCTIONS, type McpConfig } from "./server";

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

export async function main(env = process.env): Promise<void> {
  const cfg = readConfig(env);
  const server = createMcpServer(cfg);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
