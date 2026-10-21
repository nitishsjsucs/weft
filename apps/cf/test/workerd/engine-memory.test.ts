// Design 8.1 and 11.4: Weft's modules plus 4 worlds in one isolate stay under 100 MB of heap. weft-core runs alone
// under wrangler's startWorker (its V8 inspector reachable), with the real engine and a test entry
// (test/support/core-entry-real.ts); the heap of its isolate is read over CDP (Runtime.getHeapUsage, after a forced
// garbage collection) with the Lobby and SpendDO up and no world booted, then with slot-1 to slot-4 restored and
// booted. Runs once cf1, cf2 and cf3 are merged and pnpm cf:snapshot has built apps/cf/generated.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { writeLocalConfigs } from "../../../../scripts/cf/lib/configs";
import { missingDeps } from "../../src/core/company/deps";
import { CF_DIR, REPO } from "../support/config-files";

const ready = missingDeps().length === 0 && existsSync(join(CF_DIR, "generated/manifest.json"));

/** Heap used by every isolate the inspector lists, in MB, after asking for a full GC. */
async function heapMb(inspector: URL): Promise<{ title: string; mb: number }[]> {
  const targets = (await (await fetch(`http://${inspector.host}/json/list`)).json()) as { title: string; webSocketDebuggerUrl: string }[];
  const out: { title: string; mb: number }[] = [];
  for (const t of targets) {
    // wrangler's inspector proxy accepts the devtools origin.
    const ws = new WebSocket(t.webSocketDebuggerUrl, { headers: { origin: "https://devtools.devprod.cloudflare.dev" } } as never);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const waiting = new Map<number, (m: { result?: { usedSize?: number } }) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as { id?: number; result?: { usedSize?: number } }; if (m.id !== undefined) waiting.get(m.id)?.(m); };
    let id = 0;
    const call = (method: string, ms: number) => new Promise<{ result?: { usedSize?: number } }>((res) => {
      const my = ++id;
      const timer = setTimeout(() => res({}), ms);
      waiting.set(my, (m) => { clearTimeout(timer); res(m); });
      ws.send(JSON.stringify({ id: my, method }));
    });
    await call("HeapProfiler.collectGarbage", 15_000);
    const u = await call("Runtime.getHeapUsage", 15_000);
    out.push({ title: t.title, mb: (u.result?.usedSize ?? 0) / 1024 / 1024 });
    ws.close();
  }
  return out;
}

describe.skipIf(!ready)("isolate memory with the real engine", () => {
  const dir = join(REPO, ".scratch", "cf4-worker", "harness", `memory-${process.pid}`);
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  beforeAll(async () => {
    mkdirSync(join(dir, "assets"), { recursive: true });
    const paths = writeLocalConfigs({ dir, engine: "real", origin: "http://weft.test", poolSize: 4, assetsDir: join(dir, "assets"), configMemoMs: 200 });
    // weft-core runs alone here: drop the service bindings to the fakes worker (nothing in this case calls them).
    const core = JSON.parse(readFileSync(paths.core, "utf8")) as Record<string, unknown>;
    delete core.services;
    writeFileSync(paths.core, JSON.stringify(core));
    const secret = () => randomBytes(32).toString("hex");
    worker = await unstable_startWorker({
      config: paths.core,
      entrypoint: join(CF_DIR, "test/support/core-entry-real.ts"),
      bindings: Object.fromEntries(["WEFT_SESSION_SECRET", "WEFT_CTX_SECRET", "WEFT_PROXY_SECRET", "WEFT_VAULT_KEY"].map((k) => [k, { type: "secret_text", value: secret() }])),
      dev: { inspector: { port: 0 }, server: { port: 0 }, persist: false, logLevel: "warn" },
    } as never);
    await worker.ready;
  }, 180_000);
  afterAll(async () => { await worker?.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it("keeps Weft's modules and 4 worlds under 100 MB of heap", async () => {
    const inspector = await worker.inspectorUrl;
    expect(inspector).toBeTruthy();
    expect((await worker.fetch("http://weft.test/__test/heartbeat?slot=nobody")).status).toBe(200);   // Lobby side up
    const before = await heapMb(inspector!);
    const r = await worker.fetch("http://weft.test/__test/provision", { method: "POST", body: JSON.stringify({ slots: ["slot-1", "slot-2", "slot-3", "slot-4"] }) });
    expect(r.status, await r.clone().text()).toBe(200);
    for (const slot of ["slot-1", "slot-2", "slot-3", "slot-4"]) {
      const hb = (await (await worker.fetch(`http://weft.test/__test/heartbeat?slot=${slot}`)).json()) as { stamped: { slot: string } | null };
      expect(hb.stamped?.slot).toBe(slot);
    }
    const after = await heapMb(inspector!);
    const core = (xs: { title: string; mb: number }[]) => Math.max(...xs.map((x) => x.mb));
    console.log(`weft-core isolate heap: ${core(before).toFixed(1)} MB before any world, ${core(after).toFixed(1)} MB with 4 worlds (targets: ${after.map((a) => `${a.title} ${a.mb.toFixed(1)}`).join(", ")})`);
    expect(core(after)).toBeLessThan(100);
  }, 400_000);
});
