// The cf scripts' logic without the network (design 9.1 to 9.4 and 10): config rendering, idempotent resources with a
// read-only billing check, the build's size limits and import scan, the deploy refusals, and the budget findings.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fingerprint } from "../../../../packages/executor/src/vault/vault";
import { CfApiError, type CfApi } from "../../../../scripts/cf/lib/cf-api";
import { deployConfigs, PLACEHOLDER_IDS, readResources, writeLocalConfigs } from "../../../../scripts/cf/lib/configs";
import { readEnvValue } from "../../../../scripts/cf/lib/env-file";
import { scanImports } from "../../../../scripts/cf/lib/import-scan";
import { ensureResources, NAMES } from "../../../../scripts/cf/resources";
import { parseUploadSize, sizeProblems, type BuildRecord } from "../../../../scripts/cf/build";
import { deployRefusals } from "../../../../scripts/cf/deploy";
import { summarize, type BudgetData } from "../../../../scripts/cf/budget";
import { snapshotId, vaultFingerprint } from "../../../../scripts/cf/snapshot";
import { devVars, portInUse } from "../../../../scripts/cf/dev";

const dir = mkdtempSync(join(tmpdir(), "weft-cf-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("config rendering", () => {
  it("fills the resource ids, the sitekey and the gateway account id, and keeps placeholders without resources", () => {
    const none = deployConfigs({ resources: null });
    expect((none.core.kv_namespaces as { id: string }[])[0]!.id).toBe(PLACEHOLDER_IDS.kv);
    expect((none.front.vars as Record<string, string>).TURNSTILE_SITEKEY).toBe(PLACEHOLDER_IDS.sitekey);
    const r = { version: 1 as const, kv: { CONFIG: "k".repeat(32) }, d1: { OPS: "d1-id" }, turnstile: { sitekey: "0x4AAA" }, updatedAt: "x" };
    const c = deployConfigs({ resources: r, accountId: "acct", assetsDir: "/tmp/out" });
    expect((c.core.kv_namespaces as { id: string }[])[0]!.id).toBe(r.kv.CONFIG);
    expect((c.front.kv_namespaces as { id: string }[])[0]!.id).toBe(r.kv.CONFIG);
    expect((c.core.d1_databases as { database_id: string }[])[0]!.database_id).toBe("d1-id");
    expect((c.front.vars as Record<string, string>).TURNSTILE_SITEKEY).toBe("0x4AAA");
    expect((c.core.vars as Record<string, string>).WEFT_AIG_ACCOUNT_ID).toBe("acct");
    expect((c.front.assets as { directory: string }).directory).toBe("/tmp/out");
    const f = join(dir, "resources.json");
    writeFileSync(f, JSON.stringify(r));
    expect(readResources(f)).toEqual(r);
    writeFileSync(f, "{}");
    expect(readResources(f)).toBeNull();
  });

  it("makes the local configs: fakes for AI, Vectorize and Browser Run, everything else as deployed", () => {
    const p = writeLocalConfigs({ dir: join(dir, "local"), engine: "fake", origin: "http://localhost:5780", assetsDir: "/tmp/a", poolSize: 3 });
    const core = JSON.parse(readFileSync(p.core, "utf8")) as Record<string, unknown>;
    const front = JSON.parse(readFileSync(p.front, "utf8")) as Record<string, unknown>;
    expect(core).not.toHaveProperty("ai");
    expect(core).not.toHaveProperty("vectorize");
    expect(core).not.toHaveProperty("browser");
    expect((core.services as { binding: string }[]).map((s) => s.binding)).toEqual(["AI", "MEMVEC", "BROWSER"]);
    expect(core.main).toMatch(/test\/support\/core-entry\.ts$/);
    expect(core.workflows).toEqual([{ name: "weft-reseed", binding: "RESEED", class_name: "ReseedWorkflow" }]);
    expect(core).toHaveProperty("queues");
    expect(core).toHaveProperty("images");
    expect((core.vars as Record<string, string>)).toMatchObject({ WEFT_LLM: "scripted", WEFT_POOL_SIZE: "3", WEFT_PUBLIC_ORIGIN: "http://localhost:5780" });
    expect((front.assets as { directory: string }).directory).toBe("/tmp/a");
    expect((front.vars as Record<string, string>).TURNSTILE_SITEKEY).toBe("1x00000000000000000000AA");
    const real = writeLocalConfigs({ dir: join(dir, "local2"), engine: "real", origin: "http://x", assetsDir: "/tmp/a" });
    expect((JSON.parse(readFileSync(real.core, "utf8")) as { main: string }).main).toMatch(/src\/core\/index\.ts$/);
  });
});

/** A fake account: lists, creates and the subscriptions read; records every call. */
function fakeAccount(o: { billingChanges?: boolean } = {}) {
  const calls: string[] = [];
  const state = { kv: [] as { id: string; title: string }[], d1: [] as { uuid: string; name: string }[], r2: [] as string[], queues: [] as string[], index: false, meta: [] as string[], gateways: [] as string[], widgets: [] as { sitekey: string; name: string; secret: string }[] };
  let subs = 0;
  const api: CfApi = {
    accountId: "acct",
    async get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      if (path.includes("/subscriptions")) { subs += 1; return [{ id: "s1", rate_plan: { id: o.billingChanges && subs > 1 ? "paid" : "free" }, price: 0 }] as T; }
      if (path.includes("/storage/kv/namespaces")) return state.kv as T;
      if (path.includes("/d1/database")) return state.d1 as T;
      if (path.endsWith("/r2/buckets")) return { buckets: state.r2.map((name) => ({ name })) } as T;
      if (path.endsWith("/queues")) return state.queues.map((queue_name) => ({ queue_name })) as T;
      if (path.endsWith("/metadata_index/list")) return { metadataIndexes: state.meta.map((propertyName) => ({ propertyName })) } as T;
      if (path.includes("/vectorize/v2/indexes/")) { if (!state.index) throw new CfApiError(404, [], "not found"); return {} as T; }
      if (path.includes("/ai-gateway/gateways/")) { if (!state.gateways.includes(path.split("/").pop()!)) throw new CfApiError(404, [], "not found"); return {} as T; }
      if (path.includes("/challenges/widgets/")) return { secret: state.widgets[0]!.secret } as T;
      if (path.includes("/challenges/widgets")) return state.widgets.map(({ sitekey, name }) => ({ sitekey, name })) as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      const b = body as Record<string, string>;
      if (path.endsWith("/storage/kv/namespaces")) { state.kv.push({ id: "kv1", title: b.title! }); return { id: "kv1" } as T; }
      if (path.endsWith("/d1/database")) { state.d1.push({ uuid: "d1-uuid", name: b.name! }); return { uuid: "d1-uuid" } as T; }
      if (path.endsWith("/r2/buckets")) { state.r2.push(b.name!); return {} as T; }
      if (path.endsWith("/queues")) { state.queues.push(b.queue_name!); return {} as T; }
      if (path.endsWith("/vectorize/v2/indexes")) { state.index = true; return {} as T; }
      if (path.endsWith("/metadata_index/create")) { state.meta.push((body as { propertyName: string }).propertyName); return {} as T; }
      if (path.endsWith("/ai-gateway/gateways")) { state.gateways.push(b.id!); return {} as T; }
      if (path.endsWith("/challenges/widgets")) { state.widgets.push({ sitekey: "0xSITE", name: b.name!, secret: "0xSECRET_" + "s".repeat(20) }); return { sitekey: "0xSITE", secret: state.widgets[0]!.secret } as T; }
      throw new Error(`unexpected POST ${path}`);
    },
    async put<T>(path: string): Promise<T> { calls.push(`PUT ${path}`); return {} as T; },
    async graphql<T>(): Promise<T> { throw new Error("no graphql here"); },
  };
  return { api, calls, state };
}

describe("pnpm cf:resources", () => {
  it("creates every resource once, then finds them all, and never prints the Turnstile secret or the gateway name", async () => {
    const acct = fakeAccount();
    const secretsFile = join(dir, "res.secrets.env");
    const resourcesFile = join(dir, "res.json");
    const lines: string[] = [];
    const first = await ensureResources(acct.api, { plan: false, secretsFile, resourcesFile, log: (l) => lines.push(l) });
    expect(first.steps.filter((s) => s.action === "create").map((s) => s.resource)).toEqual([
      `KV ${NAMES.kv}`, `D1 ${NAMES.d1}`, `R2 ${NAMES.r2}`, "Queue weft-jobs", "Queue weft-render", "Queue weft-dlq", `Vectorize ${NAMES.vectorize}`,
      "Vectorize metadata index gen", "Vectorize metadata index tainted", "Vectorize metadata index kind", "AI Gateway (secret name)", `Turnstile widget ${NAMES.turnstile}`,
    ]);
    expect(first.resources).toMatchObject({ kv: { CONFIG: "kv1" }, d1: { OPS: "d1-uuid" }, turnstile: { sitekey: "0xSITE" } });
    expect(JSON.parse(readFileSync(resourcesFile, "utf8"))).toMatchObject({ kv: { CONFIG: "kv1" } });
    const secret = readEnvValue(secretsFile, "TURNSTILE_SECRET")!;
    const gateway = readEnvValue(secretsFile, "WEFT_AIG_GATEWAY")!;
    expect(secret).toMatch(/^0xSECRET_/);
    expect(gateway).toMatch(/^weft-[0-9a-f]{12}$/);
    const printed = lines.join("\n") + JSON.stringify(first);
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(gateway);
    expect(acct.calls.filter((c) => c.includes("subscriptions"))).toHaveLength(2);

    const again = await ensureResources(acct.api, { plan: false, secretsFile, resourcesFile, log: () => undefined });
    expect(again.steps.filter((s) => s.action === "create")).toEqual([]);
  });

  it("only reads with --plan", async () => {
    const acct = fakeAccount();
    const r = await ensureResources(acct.api, { plan: true, secretsFile: join(dir, "plan.env"), resourcesFile: join(dir, "plan.json"), log: () => undefined });
    expect(acct.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(r.resources).toBeNull();
    expect(readEnvValue(join(dir, "plan.env"), "WEFT_AIG_GATEWAY")).toBeNull();
  });

  it("stops when the subscriptions changed", async () => {
    const acct = fakeAccount({ billingChanges: true });
    await expect(ensureResources(acct.api, { plan: true, secretsFile: join(dir, "b.env"), resourcesFile: join(dir, "b.json"), log: () => undefined })).rejects.toThrow(/STOP/);
  });
});

describe("pnpm cf:build", () => {
  it("reads wrangler's upload size and holds the limits", () => {
    expect(parseUploadSize("Total Upload: 7027.79 KiB / gzip: 1429.41 KiB\n")).toEqual({ uploadKiB: 7027.79, gzipKiB: 1429.41 });
    expect(parseUploadSize("Total Upload: 1.50 MiB / gzip: 0.50 MiB")).toEqual({ uploadKiB: 1536, gzipKiB: 512 });
    expect(parseUploadSize("nothing")).toBeNull();
    expect(sizeProblems({ front: { uploadKiB: 40, gzipKiB: 12 }, core: { uploadKiB: 7000, gzipKiB: 1400 } })).toEqual([]);
    expect(sizeProblems({ front: { uploadKiB: 1024, gzipKiB: 1 }, core: { uploadKiB: 16 * 1024, gzipKiB: 1 } })).toHaveLength(2);
  });

  it("finds node:fs and friends reachable from the entry, through dynamic imports, with the chain", () => {
    const meta = {
      inputs: {
        "src/core/index.ts": { imports: [{ path: "src/core/lazy.ts", kind: "dynamic-import" }, { path: "cloudflare:workers", kind: "import-statement", external: true }] },
        "src/core/lazy.ts": { imports: [{ path: "../api/assemble.ts", kind: "import-statement" }] },
        "../api/assemble.ts": { imports: [{ path: "node:fs", kind: "import-statement", external: true }, { path: "node:crypto", kind: "import-statement", external: true }] },
        "src/front/index.ts": { imports: [{ path: "node:net", kind: "import-statement", external: true }] },
      },
    };
    const r = scanImports(meta, (p) => p === "src/core/index.ts");
    expect(r.reachable).toEqual([{ module: "node:fs", chain: ["src/core/index.ts", "src/core/lazy.ts", "../api/assemble.ts"] }]);
    expect(r.inputs).toBe(3);
  });
});

describe("pnpm cf:deploy", () => {
  const key = "a".repeat(64);
  const good: BuildRecord = {
    sha: "f".repeat(40), dirty: false, dir: "/x", createdAt: "t", placeholders: { snapshot: false, web: false, resources: false },
    sizes: { front: { uploadKiB: 40, gzipKiB: 12 }, core: { uploadKiB: 7000, gzipKiB: 1400 } }, importScan: { reachable: [], inputs: 1 },
    snapshot: { id: "snap", vaultKeyFingerprint: vaultFingerprint(key) }, deployable: true,
  };
  it("deploys only a complete build sealed with the deploy vault key", () => {
    expect(deployRefusals(good, key)).toEqual([]);
    expect(deployRefusals({ ...good, placeholders: { snapshot: true, web: true, resources: true } }, key)).toHaveLength(3);
    expect(deployRefusals({ ...good, dirty: true }, key)).toHaveLength(1);
    expect(deployRefusals(good, "b".repeat(64))).toEqual(["the snapshot was sealed with another vault key (pnpm cf:build --deploy-snapshot)"]);
    expect(deployRefusals({ ...good, snapshot: { id: "s", vaultKeyFingerprint: "local:" + vaultFingerprint(key) } }, key)).toHaveLength(1);
    expect(deployRefusals(good, null)).toHaveLength(1);
  });

  it("fingerprints the vault key exactly as the vault does", () => {
    expect(vaultFingerprint(key)).toBe(fingerprint(key));
    expect(snapshotId("d", "j")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("pnpm cf:budget", () => {
  const data: BudgetData = {
    workers: [
      { dimensions: { scriptName: "weft", status: "success" }, sum: { requests: 900, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 600, cpuTimeP99: 2400 } },
      { dimensions: { scriptName: "weft-core", status: "success" }, sum: { requests: 10, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 300, cpuTimeP99: 900 } },
    ],
    objects: [{ dimensions: { namespaceId: "n1" }, sum: { cpuTime: 12_000_000, rowsRead: 50_000, rowsWritten: 3_000, exceededCpuErrors: 0, exceededMemoryErrors: 0 } }],
    gateway: [{ dimensions: { gateway: "weft-x", provider: "openai" }, sum: { cost: 0.012, requests: 10, cachedRequests: 1 } }],
  };
  it("is quiet within the targets and the ledger", () => {
    const s = summarize("2026-10-26", data, 0.0121, "weft-x");
    expect(s.findings).toEqual([]);
    expect(s.scripts.weft).toMatchObject({ requests: 900, cpuP99Ms: 2.4 });
    expect(s.objects).toMatchObject({ rowsWritten: 3000, rowsRead: 50_000, cpuMs: 12_000 });
  });
  it("reports CPU over target, exceeded resources, rows over the share and a ledger gap", () => {
    const bad: BudgetData = {
      workers: [...data.workers, { dimensions: { scriptName: "weft", status: "exceededResources" }, sum: { requests: 2, errors: 2, subrequests: 0 }, quantiles: { cpuTimeP50: 1, cpuTimeP99: 9_000 } }],
      objects: [{ dimensions: { namespaceId: "n" }, sum: { cpuTime: 1, rowsRead: 4_000_000, rowsWritten: 70_000, exceededCpuErrors: 1, exceededMemoryErrors: 1 } }],
      gateway: data.gateway,
    };
    const f = summarize("2026-10-26", bad, 0.5, "weft-x").findings.join("\n");
    for (const s of ["front CPU p99 9.0 ms", "2 exceededResources", "exceeded CPU", "exceeded memory", "rows written 70000", "rows read 4000000", "gap"]) expect(f).toContain(s);
  });
});

describe("pnpm cf:dev helpers", () => {
  it("generates the local secrets once and checks the port", () => {
    const a = devVars(join(dir, "dev"));
    const b = devVars(join(dir, "dev"));
    expect(a).toEqual(b);
    expect(a.WEFT_VAULT_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(a.TURNSTILE_SECRET).toBe("1x0000000000000000000000000000000AA");
    expect(portInUse(5799)).toBe(false);
  });
});
