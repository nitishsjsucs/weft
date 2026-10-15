// MCP stdio server (SPEC 9.8). Owner: t3-governance. A thin client of GET/POST /v1/tools with the mcp-scope key.
// Reads WEFT_API_URL and WEFT_API_KEY; registers every read and propose tool plus agent_ask; never exposes approve,
// deny, rollback, vault, settings or memory writes. Uses McpServer.registerTool and StdioServerTransport
// (@modelcontextprotocol/sdk/server/stdio.js). The scaffold only validates its configuration.
export interface McpConfig { apiUrl: string; apiKey: string }

export const SERVER_INSTRUCTIONS =
  "Weft runs on synthetic data for a fictional company (Larkspur Robotics (demo)). Every person, agency, bank and carrier is simulated. " +
  "Write tools only create proposals that a human approves in the Weft app.";

export function readConfig(env: Record<string, string | undefined>): McpConfig {
  const apiUrl = env.WEFT_API_URL ?? "http://127.0.0.1:4070";
  const apiKey = env.WEFT_API_KEY ?? "";
  if (!apiKey) throw new Error("WEFT_API_KEY is required (the mcp-scope key from .data/demo-mcp-key.txt)");
  return { apiUrl, apiKey };
}

export async function main(env = process.env): Promise<void> {
  readConfig(env);
  throw new Error("apps/mcp is not implemented yet (t3-governance)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
