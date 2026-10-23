// Stand-ins for the bindings Miniflare does not emulate locally (Workers AI, Vectorize, Browser Run), served as RPC
// entrypoints that weft-core's test config binds in their place. Each records its calls so a test (or cf6-extras'
// suite under test/extras) can assert what was asked and stay idempotent on redelivery. No network, no real model.
import { WorkerEntrypoint } from "cloudflare:workers";

const calls: { binding: string; method: string; args: unknown }[] = [];
const vectors = new Map<string, { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }>();

export class FakeAi extends WorkerEntrypoint {
  async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    calls.push({ binding: "AI", method: "run", args: { model, options: options ?? null } });
    if (model.includes("bge")) {
      const texts = (inputs.text as string[] | string | undefined) ?? [];
      const list = Array.isArray(texts) ? texts : [texts];
      return { shape: [list.length, 768], data: list.map((t) => Array.from({ length: 768 }, (_, i) => ((t.length + i) % 7) / 7)) };
    }
    if (model.includes("whisper")) return { text: "fake dictation" };
    if (model.includes("mistral")) return { response: JSON.stringify({ merchant: "Fake Cafe (demo)", date: "2026-10-20", totalCents: 1062, currency: "USD", confidence: 0.9 }) };
    return { output: [{ type: "message", content: [{ type: "output_text", text: "fake" }] }], usage: { input_tokens: 10, output_tokens: 2 } };
  }
}

export class FakeVectorize extends WorkerEntrypoint {
  async upsert(items: { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }[]) {
    calls.push({ binding: "MEMVEC", method: "upsert", args: items.map((i) => i.id) });
    for (const i of items) vectors.set(i.id, i);
    return { mutationId: `m${calls.length}` };
  }
  async query(_vector: number[], opts: { topK?: number; namespace?: string } = {}) {
    calls.push({ binding: "MEMVEC", method: "query", args: opts });
    const matches = [...vectors.values()].filter((v) => !opts.namespace || v.namespace === opts.namespace).slice(0, opts.topK ?? 5)
      .map((v) => ({ id: v.id, score: 0.9, metadata: v.metadata }));
    return { matches, count: matches.length };
  }
  async deleteByIds(ids: string[]) {
    calls.push({ binding: "MEMVEC", method: "deleteByIds", args: ids });
    for (const id of ids) vectors.delete(id);
    return { mutationId: `d${calls.length}` };
  }
}

/**
 * Browser Run is not emulated: @cloudflare/puppeteer's launch() asks the binding for a session (POST
 * /v1/devtools/browser) and then speaks the DevTools protocol over a WebSocket, which a stand-in cannot serve. The
 * session request is refused with 501 at once, so a render fails with that reason (it retries and ends in weft-dlq)
 * instead of failing later on a reply that is not JSON. The renderer's own cases use a fake launcher; the deployed
 * smoke renders real PDFs.
 */
export class FakeBrowser extends WorkerEntrypoint {
  override async fetch(req: Request): Promise<Response> {
    calls.push({ binding: "BROWSER", method: "fetch", args: new URL(req.url).pathname });
    return Response.json({ success: false, errors: [{ message: "Browser Run is not emulated locally (fakes worker): PDFs render on the deployed Worker only" }] }, { status: 501 });
  }
}

export class FakeCalls extends WorkerEntrypoint {
  async list() { return [...calls]; }
  async clear() { calls.length = 0; vectors.clear(); }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ calls });
  },
};
