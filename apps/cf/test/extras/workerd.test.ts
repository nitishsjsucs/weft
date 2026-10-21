// The extras in workerd (design 11.4, last item; Miniflare under plain vitest): the real HostedExtras entrypoint
// reached over a service binding from a front stand-in, and the real queue consumer fed through Miniflare's local
// Queues, over its D1 (with apps/cf/d1 applied), R2 and KV, with Durable Objects that implement the extras RPC seams
// (the Lobby's counters on real DO SQLite). Workers AI and AI Search are a fake worker bound by RPC; Browser Run is
// swapped for a fake on the render queue only. Shows: Help stops at 30 a day, a redelivered OCR job makes one model
// call and one write-back, a render job stores its PDF in R2, and dictation returns text.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfObjectKey, renderPdfHtml, sha256Hex, toBase64 } from "@weft/cf-extras";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..", "..", "..");
const D1_DIR = join(ROOT, "apps", "cf", "d1");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0xff, 0xd9]);

async function bundle(entry: string): Promise<string> {
  const r = await build({
    absWorkingDir: ROOT, entryPoints: [join(HERE, "workerd", entry)], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2024",
    conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"], logLevel: "silent",
    // Puppeteer is imported only inside the Browser Run launcher, which this test never calls.
    external: ["cloudflare:*", "node:*", "@cloudflare/puppeteer", ...builtinModules],
  });
  return r.outputFiles[0]!.text;
}
const esm = (contents: string) => ({ mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } });

let mf: Miniflare;
const CORE = "weft-core-extras";
const front = (path: string, init?: { method?: string; body?: string | Uint8Array }) => mf.dispatchFetch(`http://front.local${path}`, init as never);
const core = async (path: string, body: unknown) => (await (await mf.getWorker(CORE)).fetch(`http://core.local${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json() as Promise<any>;
const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (ok(v) || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); }
};

beforeAll(async () => {
  const [coreJs, aiJs, clientJs] = await Promise.all([bundle("core.ts"), bundle("fake-ai.ts"), bundle("client.ts")]);
  const compat = { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] };
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "front", ...compat, manifest: esm(clientJs),
          env: { CORE: { type: "worker", worker: CORE, exportName: "HostedExtras" }, AI_FAKE: { type: "worker", worker: "fake-ai", exportName: "FakeAi" } },
        },
      },
      {
        config: {
          name: CORE, ...compat, manifest: esm(coreJs),
          env: {
            AI: { type: "worker", worker: "fake-ai", exportName: "FakeAi" }, HELP: { type: "worker", worker: "fake-ai", exportName: "FakeSearch" },
            FILES: { type: "r2" }, OPS: { type: "d1" }, CONFIG: { type: "kv" },
            COMPANY: { type: "durable-object", worker: CORE, exportName: "FakeCompany" }, LOBBY: { type: "durable-object", worker: CORE, exportName: "FakeLobby" },
            SPEND: { type: "durable-object", worker: CORE, exportName: "FakeSpend" },
            JOBS: { type: "queue", name: "weft-jobs" }, RENDER: { type: "queue", name: "weft-render" },
          },
          exports: { FakeCompany: { type: "durable-object", storage: "sqlite" }, FakeLobby: { type: "durable-object", storage: "sqlite" }, FakeSpend: { type: "durable-object", storage: "sqlite" } },
          triggers: [
            { type: "queue", name: "weft-jobs", maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 2, deadLetterQueue: "weft-dlq" },
            { type: "queue", name: "weft-render", maxBatchSize: 1, maxBatchTimeout: 1, maxRetries: 2, deadLetterQueue: "weft-dlq" },
            { type: "queue", name: "weft-dlq", maxBatchSize: 10, maxBatchTimeout: 1 },
          ],
        },
      },
      { config: { name: "fake-ai", ...compat, manifest: esm(aiJs) } },
    ],
  } as never);
  await mf.ready;
  const db = await mf.getD1Database("OPS", CORE);
  for (const f of readdirSync(D1_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(D1_DIR, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
}, 120_000);
afterAll(async () => { await mf?.dispose(); });

describe("extras in workerd", () => {
  it("HostedExtras answers Help over the service binding, 30 a day by the Lobby's DO SQLite counter", async () => {
    const results: { ok: boolean; code?: string; hits?: { path: string }[] }[] = [];
    for (let i = 0; i < 31; i++) results.push(await (await front(`/help?q=${encodeURIComponent(`tour ${i}`)}`)).json() as never);
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    expect(results[0]!.hits![0]!.path).toBe("help/tour.md");
    expect(results.at(-1)).toMatchObject({ ok: false, code: "HELP_DAILY_CAP" });
    expect((await (await front("/calls")).json() as { search: number }).search).toBe(30);
    const p = await (await front("/platform")).json() as { shares: Record<string, { used: number }>; restoresLeft: number; deadLetters: number };
    expect(p).toMatchObject({ restoresLeft: 2, deadLetters: 0, shares: { "help.queries": { used: 30, share: 30 } } });
  }, 60_000);

  it("a redelivered OCR job makes one model call and one write-back, recorded in D1", async () => {
    const world = { slot: "slot-1", gen: 1, mode: "slot", snapshot: "snap1", lease: { visitor: "v_1", ipHash: "ip_1" } };
    const { sha } = await core("/setup", { world, bytes: toBase64(JPEG) });
    const job = { v: 1, kind: "ocr.receipt", jobId: "obx_w1", slot: "slot-1", gen: 1, uploadId: "upl_0042", expenseId: "exp_0201", sha256: sha, storagePath: `blob:${sha}`, contentType: "image/jpeg" };
    await core("/send", { queue: "jobs", body: job });
    await core("/send", { queue: "jobs", body: job });
    const db = await mf.getD1Database("OPS", CORE);
    const done = await until(() => db.prepare("SELECT state, outcome FROM jobs WHERE job_id = ?").bind("obx_w1").first<{ state: string; outcome: string }>(), (r) => r?.state === "done");
    expect(done).toEqual({ state: "done", outcome: "attached" });
    await new Promise((r) => setTimeout(r, 2500));
    const wbs = await (await (await mf.getWorker(CORE)).fetch("http://core.local/writebacks?slot=slot-1")).json() as { command: string; args: { extract: { totalCents: number } } }[];
    expect(wbs).toHaveLength(1);
    expect(wbs[0]).toMatchObject({ command: "expenses.attach_receipt_extract", args: { job_id: "obx_w1", extract: { totalCents: 4138, merchant: "Corner Deli (demo)" } } });
    const calls = await (await front("/calls")).json() as { ai: number };
    expect(calls.ai).toBe(1);
  }, 60_000);

  it("a render job stores its PDF in R2 through a browser that loads nothing", async () => {
    const html = renderPdfHtml({ kind: "offer_letter", companyName: "Larkspur Labs (demo)", documentId: "doc_0007", title: "Offer letter", bodyText: "Dear Noor (demo)", sha256: "a".repeat(64), status: "sent", sentAt: null, signature: null });
    const sha256 = await sha256Hex(html);
    await core("/send", { queue: "render", body: { v: 1, kind: "render.pdf", jobId: "obx_w2", slot: "slot-1", gen: 1, pdf: "offer_letter", subjectId: "doc_0007", sha256, html } });
    const db = await mf.getD1Database("OPS", CORE);
    const done = await until(() => db.prepare("SELECT state, outcome FROM jobs WHERE job_id = ?").bind("obx_w2").first<{ state: string; outcome: string }>(), (r) => r?.state === "done");
    expect(done).toEqual({ state: "done", outcome: "rendered" });
    const r2 = await mf.getR2Bucket("FILES", CORE);
    const obj = await r2.get(pdfObjectKey({ scope: "world", slot: "slot-1", gen: 1, sha256 }));
    expect(obj?.httpMetadata?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(new Uint8Array(await obj!.arrayBuffer()).subarray(0, 5))).toBe("%PDF-");
  }, 60_000);

  it("dictation returns text for the composer, and the run catalog feeds the comparison", async () => {
    const wav = new Uint8Array(44 + 64_000);
    const dv = new DataView(wav.buffer);
    const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
    put(0, "RIFF"); dv.setUint32(4, 36 + 64_000, true); put(8, "WAVE"); put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16_000, true); dv.setUint32(28, 32_000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, "data"); dv.setUint32(40, 64_000, true);
    expect(await (await front("/dictate", { method: "POST", body: wav })).json()).toEqual({ ok: true, text: "Show payroll cost by month", seconds: 2, neurons: 2 });
    const row = { runId: "run_0001", slot: "slot-1", gen: 1, provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", trigger: "chat", steps: 5, grounded: true, costUsdMicros: 4400, neurons: 400, latencyMs: 2100, status: "done", terminalReason: "DONE", endedAt: new Date().toISOString() };
    expect((await front("/record", { method: "POST", body: JSON.stringify(row) })).status).toBe(200);
    expect(await (await front("/models")).json()).toMatchObject([{ provider: "workers_ai", runs: 1, avgNeurons: 400, groundedRate: 1 }]);
  }, 60_000);
});
