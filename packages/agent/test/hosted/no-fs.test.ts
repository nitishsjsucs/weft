// The durable path makes no node:fs call (docs/cloudflare/design.md 3.3 and 6.4): with the hosted options (a script
// source, environment-only secrets, the SpendDO-style ledger, the alarm host), a chat run through the Node entry reads
// and writes no file. node:fs is wrapped so that, once armed, any call fails the test.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimClock } from "@weft/contracts";

const guard = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real)) {
    wrapped[k] = typeof v === "function" && /^[a-z]/.test(k)
      ? (...args: unknown[]) => { if (guard.armed) { guard.calls.push(k); throw new Error(`node:fs.${k} on the durable path`); } return (v as (...a: unknown[]) => unknown)(...args); }
      : v;
  }
  return { ...wrapped, default: wrapped };
});

const { mkdtempSync, rmSync } = await import("node:fs");
const { closeDb, migrate, openDb } = await import("@weft/db");
const agent = await import("../../src/index");
const { createFakeExecutor } = await import("../fake-executor");
const { sqliteStorage } = await import("./sqlite-storage");

const clock: SimClock = { now: () => "2026-10-26T16:00:00.000Z", rate: () => 0, advance: async () => undefined, set: async () => undefined };
let dataDir: string;
let db: Awaited<ReturnType<typeof openDb>>;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "weft-nofs-"));
  db = openDb({ dataDir });
  await migrate(db);
});
afterEach(async () => {
  guard.armed = false;
  guard.calls.length = 0;
  await closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the agent on the durable platform's options", () => {
  it("acceptance: provider, runtime and ledger run a chat to done with zero node:fs calls", async () => {
    const storage = sqliteStorage();
    const scripts = agent.inlineScriptSource({ hello: { match: "hello", agents: { main: [{ output: [{ type: "text", text: "Hello from the bundle." }] }] } } });
    guard.armed = true;
    // A secrets file is named, but the durable platform reads the environment only; scripts come from the bundle.
    const env = { WEFT_SECRETS_FILE: join(dataDir, "secrets.env"), WEFT_LLM: "scripted" };
    const hosted = agent.createHostedSpendLedger({ store: agent.createSqlSpendStore(storage) });
    const ledger = agent.bindSpendLedger(hosted, { world: () => "slot-1:gen-1", visitor: () => "vis_a", ipHash: () => "ip_a" });
    const provider = agent.createProvider({ env, ledger, testMode: true, scriptSource: scripts, envOnlySecrets: true });
    const host = agent.alarmRunHost();
    const rt = agent.createAgentRuntime({ db, clock, executor: createFakeExecutor([]), provider, ledger, env, scriptSource: scripts, runHost: host, routinesView: { get: async () => null } });
    await rt.boot();
    const h = { runId: "run_0001", token: "tok" };
    await rt.startChat(h, { text: "hello", recipe: "chat", pageContext: null });
    await host.drain();
    expect(await rt.settled(h.runId)).toMatchObject({ status: "done", summary: "Hello from the bundle." });
    expect(await hosted.status({ visitor: "vis_a" })).toMatchObject({ openReservations: 0 });
    expect(guard.calls).toEqual([]);
    // The environment-only lookup never opens the secrets file; Node's loader would.
    expect(agent.envSecret("OPENAI_API_KEY", env)).toBeNull();
    expect(guard.calls).toEqual([]);
    expect(agent.loadSecret("OPENAI_API_KEY", env)).toBeNull();
    expect(guard.calls).toEqual(["readFileSync"]);
    guard.armed = false;
    storage.close();
  });

  it("the guard is real: the Node defaults (scenarios/ and the JSONL ledger) do call node:fs", () => {
    guard.armed = true;
    // Both swallow a failed read, so the guard's record is what shows the calls.
    expect(agent.createSpendLedger({ dir: join(dataDir, "spend") }).entries()).toEqual([]);
    expect(agent.dirScriptSource(join(dataDir, "scenarios")).names()).toEqual([]);
    expect(guard.calls).toEqual(["readFileSync", "readdirSync"]);
  });
});
