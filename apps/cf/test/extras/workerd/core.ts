// The weft-core stand-in for the extras' workerd test (track cf6-extras): the real HostedExtras entrypoint and the
// real extrasQueue consumer, over Miniflare's local D1, R2, KV and Queues, with Durable Objects that implement
// exactly the extras RPC seams (a slot, the Lobby with its counters on real DO SQLite, SpendDO's neuron ledger).
// Workers AI and AI Search are a separate fake worker bound by RPC. Bundled by workerd.test.ts.
import { DurableObject } from "cloudflare:workers";
import { sqlDailyCounters, sha256Hex, type CounterTake, type LobbyReadout } from "@weft/cf-extras";
import { extrasQueue } from "../../../src/extras/entrypoint";
import { jobDepsFromEnv, type ExtrasEnv } from "../../../src/extras/env";
import { handleExtrasBatch } from "../../../src/extras/queues";
import type { HiddenWriteBack, SlotWorldInfo, WriteBackOutcome } from "../../../src/extras/ports";

export { HostedExtras } from "../../../src/extras/entrypoint";

type Ctx = ConstructorParameters<typeof DurableObject>[0];

export class FakeCompany extends DurableObject<ExtrasEnv> {
  constructor(ctx: Ctx, env: ExtrasEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS writebacks (seq INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL, args TEXT NOT NULL)");
  }
  #get(k: string): string | null { const r = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray(); return r[0]?.v ?? null; }
  #set(k: string, v: string) { this.ctx.storage.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v); }
  async setup(world: SlotWorldInfo, blob: { storagePath: string; base64: string } | null) {
    this.#set("world", JSON.stringify(world));
    if (blob) this.#set(`blob:${blob.storagePath}`, blob.base64);
  }
  async extrasWorld(): Promise<SlotWorldInfo> { return JSON.parse(this.#get("world") ?? "null") as SlotWorldInfo; }
  async extrasBlob(storagePath: string): Promise<Uint8Array | null> {
    const b = this.#get(`blob:${storagePath}`);
    return b === null ? null : Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  }
  async extrasWriteBack(w: HiddenWriteBack): Promise<WriteBackOutcome> {
    const prior = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM writebacks WHERE json_extract(args, '$.job_id') = ?", w.args.job_id).one();
    if (Number(prior.n) > 0) return { ok: true, status: "already", reason: null };
    this.ctx.storage.sql.exec("INSERT INTO writebacks (command, args) VALUES (?, ?)", w.command, JSON.stringify(w.args));
    return { ok: true, status: "attached", reason: null };
  }
  async extrasMemoryText(): Promise<string | null> { return null; }
  async extrasExport(what: "memory" | "world") { return { bytes: new TextEncoder().encode(`${what}`), contentType: "application/octet-stream" }; }
  async writeBacks(): Promise<{ command: string; args: unknown }[]> {
    return this.ctx.storage.sql.exec<{ command: string; args: string }>("SELECT command, args FROM writebacks ORDER BY seq").toArray().map((r) => ({ command: r.command, args: JSON.parse(r.args) }));
  }
}

export class FakeLobby extends DurableObject<ExtrasEnv> {
  #counters = sqlDailyCounters(this.ctx.storage.sql);
  extrasCounterTake(name: string, n: number, cap: number, day?: string): Promise<CounterTake> { return this.#counters.take(name, n, cap, day); }
  extrasCounterAdd(name: string, n: number, day?: string): Promise<number> { return this.#counters.add(name, n, day); }
  extrasCounterPeek(name: string, day?: string): Promise<number> { return this.#counters.peek(name, day); }
  async extrasReadout(): Promise<LobbyReadout> {
    return { day: new Date().toISOString().slice(0, 10), level: 0, restoresLeft: 2, leases: { active: 1, pool: 2, waitlist: 0 }, lastSweepAt: null, shares: {} };
  }
  async extrasRecordVectors(): Promise<void> { /* not exercised here */ }
}

/** SpendDO's neuron ledger, enough for the extras: per-product shares, open reservations count as used. */
export class FakeSpend extends DurableObject<ExtrasEnv> {
  constructor(ctx: Ctx, env: ExtrasEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rsv (id TEXT PRIMARY KEY, product TEXT NOT NULL, neurons INTEGER NOT NULL, settled INTEGER)");
  }
  async reserve(i: { neurons?: number; product?: string }) {
    const SHARES: Record<string, number> = { agent: 4000, ocr: 500, embeddings: 200, dictation: 300 };
    const used = Number(this.ctx.storage.sql.exec<{ n: number | null }>("SELECT sum(coalesce(settled, neurons)) AS n FROM rsv WHERE product = ?", i.product ?? "agent").one().n ?? 0);
    const cap = SHARES[i.product ?? "agent"] ?? 0;
    if (used + (i.neurons ?? 0) > cap) return { ok: false, code: "BUDGET_EXCEEDED", cap: "day", hostedCap: "neurons", spentMicros: used, capMicros: cap };
    const id = `rsv_${crypto.randomUUID()}`;
    this.ctx.storage.sql.exec("INSERT INTO rsv (id, product, neurons) VALUES (?, ?, ?)", id, i.product ?? "agent", i.neurons ?? 0);
    return { ok: true, reservationId: id };
  }
  async settle(id: string, _usd: number, actual?: { neurons?: number }) { this.ctx.storage.sql.exec("UPDATE rsv SET settled = ? WHERE id = ?", actual?.neurons ?? 0, id); }
  async status() {
    const used = Number(this.ctx.storage.sql.exec<{ n: number | null }>("SELECT sum(coalesce(settled, neurons)) AS n FROM rsv").one().n ?? 0);
    return { day: new Date().toISOString().slice(0, 10), caps: { runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 }, spentMicros: { day: 0, visitor: null, ip: null, live: 0 }, neurons: { used, byProduct: { agent: 0, ocr: used, embeddings: 0, dictation: 0 } }, openReservations: 0 };
  }
}

const slotStub = (env: ExtrasEnv, slot: string) => env.COMPANY.get(env.COMPANY.idFromName(slot)) as unknown as Pick<FakeCompany, "setup" | "writeBacks">;

/** A browser that loads nothing: every request the page attempts is aborted, and the PDF is a stub. */
const fakeLauncher = async () => ({
  async newPage() {
    let js = true, intercept = false;
    const handlers: ((r: { url(): string; abort(): Promise<void> }) => void)[] = [];
    return {
      async setJavaScriptEnabled(b: boolean) { js = b; },
      async setRequestInterception(b: boolean) { intercept = b; },
      on(_e: string, h: (r: { url(): string; abort(): Promise<void> }) => void) { handlers.push(h); },
      async setContent() {
        if (js || !intercept) throw new Error("the page must load with JavaScript off and every request intercepted");
        let aborted = false;
        for (const h of handlers) h({ url: () => "http://169.254.169.254/", abort: async () => { aborted = true; } });
        if (!aborted) throw new Error("a request was allowed");
      },
      async pdf() { return new TextEncoder().encode("%PDF-1.7\n% workerd test\n%%EOF\n"); },
      async close() {},
    };
  },
  async close() {},
});

export default {
  async queue(batch: MessageBatch<unknown>, env: ExtrasEnv, ctx: ExecutionContext) {
    // The render queue swaps in the fake browser (Browser Run is not emulated); everything else is the real consumer.
    if (batch.queue === "weft-render") return handleExtrasBatch(batch, { ...jobDepsFromEnv(env, ctx), launch: fakeLauncher });
    return extrasQueue(batch, env, ctx);
  },
  async fetch(req: Request, env: ExtrasEnv & { JOBS: Queue; RENDER: Queue }) {
    const url = new URL(req.url);
    if (url.pathname === "/setup") {
      const b = (await req.json()) as { world: SlotWorldInfo; bytes: string };
      const bytes = Uint8Array.from(atob(b.bytes), (c) => c.charCodeAt(0));
      const sha = await sha256Hex(bytes);
      await slotStub(env, b.world.slot).setup(b.world, { storagePath: `blob:${sha}`, base64: b.bytes });
      return Response.json({ sha });
    }
    if (url.pathname === "/send") {
      const b = (await req.json()) as { queue: "jobs" | "render"; body: unknown };
      await (b.queue === "jobs" ? env.JOBS : env.RENDER).send(b.body, { contentType: "json" });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/writebacks") {
      return Response.json(await slotStub(env, url.searchParams.get("slot")!).writeBacks());
    }
    return new Response("not found", { status: 404 });
  },
};

