// Test-only re-exports so scenario tests can drive the MCP server in process (InMemoryTransport + Client), and the
// remote handler through the official Streamable HTTP client.
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
export { createMcpServer, SERVER_INSTRUCTIONS } from "./main";
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { createRemoteMcpHandler } from "./remote";
