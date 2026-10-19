import { describe, expect, it } from "vitest";
import { clientConfig, readConfig, SERVER_INSTRUCTIONS } from "../src/main";

describe("apps/mcp scaffold", () => {
  it("requires the mcp key and defaults the API URL", () => {
    expect(() => readConfig({})).toThrow(/WEFT_API_KEY/);
    expect(readConfig({ WEFT_API_KEY: "weft_sk_test" })).toEqual({ apiUrl: "http://127.0.0.1:4070", apiKey: "weft_sk_test" });
    expect(SERVER_INSTRUCTIONS).toMatch(/fictional/);
  });

  it("reads the key from WEFT_API_KEY_FILE, trimmed; WEFT_API_KEY wins; an unreadable file says to seed", () => {
    const files: Record<string, string> = { "/w/.data/demo-mcp-key.txt": "weft_sk_file\n" };
    const read = (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; };
    expect(readConfig({ WEFT_API_KEY_FILE: "/w/.data/demo-mcp-key.txt" }, read).apiKey).toBe("weft_sk_file");
    expect(readConfig({ WEFT_API_KEY: "weft_sk_env", WEFT_API_KEY_FILE: "/w/.data/demo-mcp-key.txt" }, read).apiKey).toBe("weft_sk_env");
    expect(() => readConfig({ WEFT_API_KEY_FILE: "/w/missing.txt" }, read)).toThrow(/cannot be read; seed the world first/);
  });

  it("client config: stdio through pnpm --dir, the key file and no key value, no cwd key", () => {
    const c = clientConfig({ root: "/w", pnpm: "/opt/bin/pnpm", pathDirs: ["/opt/node/bin", "/opt/bin"] });
    expect(c).toEqual({ mcpServers: { weft: {
      command: "/opt/bin/pnpm",
      args: ["--silent", "--dir", "/w", "--filter", "@weft/mcp", "start"],
      env: { WEFT_API_URL: "http://127.0.0.1:4070", WEFT_API_KEY_FILE: "/w/.data/demo-mcp-key.txt", PATH: "/opt/node/bin:/opt/bin:/usr/bin:/bin" },
    } } });
    const other = clientConfig({ root: "/w", dataDir: "/tmp/d", apiPort: 4170 }).mcpServers.weft;
    expect(other.env).toEqual({ WEFT_API_URL: "http://127.0.0.1:4170", WEFT_API_KEY_FILE: "/tmp/d/demo-mcp-key.txt" });
    expect(other.command).toBe("pnpm");
    expect(JSON.stringify(c)).not.toMatch(/weft_sk_|cwd/);
  });
});
