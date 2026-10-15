// MCP smoke (SPEC 9.8, owner t3-governance): seeds a scratch data dir, starts the API on 127.0.0.1:$WEFT_SMOKE_PORT
// (default 4141, in its own process group), spawns apps/mcp over stdio with the seeded mcp key, lists the tools and
// calls a read and a propose tool, then stops everything it started. Usage: pnpm exec tsx scripts/mcp-smoke.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StdioClientTransport } from "../apps/mcp/src/testing";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.WEFT_SMOKE_PORT ?? 4141);
const tsx = join(root, "node_modules", ".bin", "tsx");

const free = (p: number) => new Promise<boolean>((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(p, "127.0.0.1", () => s.close(() => ok(true))); });

async function main(): Promise<void> {
  if (!(await free(port))) throw new Error(`port ${port} is in use; set WEFT_SMOKE_PORT to a free port in 4140 to 4159`);
  const dataDir = mkdtempSync(join(tmpdir(), "weft-mcp-smoke-"));
  const env = { ...process.env, WEFT_DATA_DIR: dataDir, WEFT_API_PORT: String(port), WEFT_LLM: "scripted", WEFT_CLOCK_RATE: "0" };
  const seed = spawnSync(tsx, [join(root, "packages/seed/src/cli.ts"), "seed"], { env, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr}`);
  const api = spawn(tsx, [join(root, "apps/api/src/main.ts")], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { try { process.kill(-api.pid!, "SIGTERM"); } catch { /* already gone */ } };
  try {
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("API did not start in 20 s")), 20_000);
      api.stdout!.on("data", (b: Buffer) => { if (String(b).includes("listening")) { clearTimeout(t); ok(); } });
      api.once("exit", (code) => { clearTimeout(t); fail(new Error(`API exited with ${code}`)); });
    });
    const key = readFileSync(join(dataDir, "demo-mcp-key.txt"), "utf8").trim();
    const transport = new StdioClientTransport({ command: tsx, args: [join(root, "apps/mcp/src/main.ts")], env: { PATH: process.env.PATH ?? "", WEFT_API_URL: `http://127.0.0.1:${port}`, WEFT_API_KEY: key } });
    const client = new Client({ name: "weft-mcp-smoke", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
    const bad = tools.filter((t) => /approve|deny|rollback|vault|settings|write_note/.test(t.name));
    if (bad.length) throw new Error(`exposed tools that must stay hidden: ${bad.map((t) => t.name).join(", ")}`);
    const read = await client.callTool({ name: "actions__list", arguments: { limit: 3, before_seq: null, run_id: null, command: null, response_format: null } });
    console.log(`actions__list: ${(read.content as { text: string }[])[0]!.text.slice(0, 200)}`);
    const update = tools.find((t) => t.name === "tax__update_rate");
    if (update) {
      // T2's tax.update_rate is checked against a notice: deliver the hero notice with the admin key, read its extract
      // over MCP, and propose exactly that change. The call must come back as a proposal, never an executed write.
      const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0]!.text) as Record<string, unknown>;
      let args: Record<string, unknown> = { rate_id: "etr_0001", rate: "0.015", source_notice_id: null };
      if ("tax_account_id" in ((update.inputSchema as { properties?: object }).properties ?? {})) {
        const admin = readFileSync(join(dataDir, "demo-api-key.txt"), "utf8").trim();
        const res = await fetch(`http://127.0.0.1:${port}/v1/sim/notices/deliver`, { method: "POST", headers: { "x-api-key": admin, "content-type": "application/json" }, body: JSON.stringify({ scenario: "ca_de2088_rate_change" }) });
        const noticeId = ((await res.json()) as { data?: { notice_id?: string } }).data?.notice_id;
        if (!noticeId) throw new Error(`could not deliver the hero notice (HTTP ${res.status})`);
        const got = text(await client.callTool({ name: "notices__get", arguments: { notice_id: noticeId, response_format: null } }));
        const n = (got.data as { notice: { tax_account_id: string; extracted: { effectiveFrom: string; rates: { code: string; newRate: string }[] } } }).notice;
        args = { tax_account_id: n.tax_account_id, code: n.extracted.rates[0]!.code, rate: n.extracted.rates[0]!.newRate, effective_from: n.extracted.effectiveFrom, source_notice_id: noticeId };
      }
      const out = text(await client.callTool({ name: "tax__update_rate", arguments: args }));
      console.log(`tax__update_rate: ${JSON.stringify(out).slice(0, 200)}`);
      if (out.status !== "pending_approval") throw new Error("tax__update_rate over MCP must return a proposal");
    }
    await client.close();
    console.log("mcp smoke: ok");
  } finally {
    stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => { console.error(`mcp smoke: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
