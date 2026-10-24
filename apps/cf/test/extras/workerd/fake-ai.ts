// Workers AI and AI Search stand-ins for the extras' workerd test (track cf6-extras), bound to the core worker as
// RPC service bindings, so `env.AI.run(...)` and `env.HELP.search(...)` run the real call shapes across workers.
import { WorkerEntrypoint } from "cloudflare:workers";

let aiCalls = 0;
let searchCalls = 0;

export class FakeAi extends WorkerEntrypoint {
  async run(model: string, inputs: Record<string, unknown>, options?: { gateway?: { id: string } }) {
    aiCalls++;
    if (model === "@cf/mistralai/mistral-small-3.1-24b-instruct") {
      const content = (inputs.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
      if (!content.some((c) => c.type === "image_url" && c.image_url?.url.startsWith("data:image/"))) throw new Error("expected an image");
      return { response: JSON.stringify({ merchant: "Corner Deli", date: "2026-10-22", total: "41.38", currency: "USD", confidence: 0.9 }), gateway: options?.gateway?.id ?? null };
    }
    if (model === "@cf/openai/whisper-large-v3-turbo") return { text: "Show payroll cost by month", transcription_info: { duration: 2 } };
    throw new Error(`no fake for ${model}`);
  }
  async calls() { return { ai: aiCalls, search: searchCalls }; }
}

export class FakeSearch extends WorkerEntrypoint {
  async search(p: { query: string }) {
    searchCalls++;
    return { search_query: p.query, chunks: [{ id: "c1", type: "text", score: 0.82, text: "The guided tour walks through the eight scenarios.", item: { key: "help/tour.md" } }] };
  }
}

export default { async fetch() { return new Response("fake ai"); } };
