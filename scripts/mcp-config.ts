// `pnpm mcp:config [--api-port N] [--data-dir DIR]`: prints a ready-to-paste MCP client config for this checkout
// (Claude Desktop's claude_desktop_config.json, the MCP Inspector's --config file, or any client that reads the
// `mcpServers` shape). The server reads the key from the data dir's demo-mcp-key.txt, so the config holds no key.
// scripts/mcp-smoke.ts connects with exactly this config, so the printed command is the one that is tested.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clientConfig } from "../apps/mcp/src/main";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const flag = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

/** A command's absolute path from this shell's PATH, or null. */
function which(cmd: string): string | null {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().startsWith("/") ? r.stdout.trim() : null;
}

/** pnpm by absolute path and node's directory on PATH, so a client started with a short PATH (a desktop app) works. */
export function configForThisCheckout(o: { apiPort?: number; dataDir?: string } = {}) {
  const pnpm = which("pnpm");
  const node = which("node") ?? process.execPath;
  return clientConfig({ root, apiPort: o.apiPort, dataDir: o.dataDir ?? process.env.WEFT_DATA_DIR, pnpm: pnpm ?? "pnpm", pathDirs: [dirname(node), ...(pnpm ? [dirname(pnpm)] : [])] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = flag("--api-port") ?? process.env.WEFT_API_PORT;
  console.log(JSON.stringify(configForThisCheckout({ apiPort: port ? Number(port) : undefined, dataDir: flag("--data-dir") }), null, 2));
}
