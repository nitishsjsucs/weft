// Workers AI neurons for the extras (design 5.2 and 5.4). Weft's daily share is 5,000 of the account's 10,000:
// agent 3,500, OCR 500, embeddings 200, dictation 300 and speech 500 (NEURON_SHARES; speech, the cursor assistant's
// spoken answers, took its 500 from the agent's 4,000 on 2026-10-24). SpendDO holds the neuron ledger, so every
// extra reserves its worst case before the call and settles what the call reports it used after (the worst case when
// it reports nothing); an open reservation counts as used, and an orphan settles at its reserved worst case.
// Track cf6-extras.
import { NEURON_SHARES, type HostedReserveInput, type HostedSpendLedger, type NeuronProduct } from "../../contracts/src/ext/cf-agent";
import { DICTATION_MAX_SECONDS, DICTATION_MODEL, EMBEDDING_MODEL, OCR_MODEL } from "../../contracts/src/ext/cf-extras";

export interface NeuronReserve {
  product: NeuronProduct;
  neurons: number;
  model: string;
  world?: string | null;
  visitor?: string | null;
  ipHash?: string | null;
}
export type NeuronReservation = { ok: true; reservationId: string } | { ok: false; code: "BUDGET_EXCEEDED"; used: number; cap: number };

export interface NeuronBudget {
  reserve(input: NeuronReserve): Promise<NeuronReservation>;
  settle(reservationId: string, neurons: number): Promise<void>;
}

/**
 * A NeuronBudget over SpendDO's HostedSpendLedger. Extras are not agent runs: no run id, no dollars (their neurons sit
 * inside the free daily allocation), so only the neuron day cap and the product's share apply.
 */
export function neuronBudgetFromLedger(ledger: Pick<HostedSpendLedger, "reserve" | "settle">): NeuronBudget {
  return {
    async reserve(i) {
      const input: HostedReserveInput = { runId: null, usdMicros: 0, model: i.model, live: false, world: i.world ?? null, visitor: i.visitor ?? null, ipHash: i.ipHash ?? null, neurons: i.neurons, product: i.product };
      const r = await ledger.reserve(input);
      return r.ok ? { ok: true, reservationId: r.reservationId } : { ok: false, code: "BUDGET_EXCEEDED", used: r.spentMicros, cap: r.capMicros };
    },
    settle: (id, neurons) => ledger.settle(id, 0, { neurons }),
  };
}

/** In-memory budget with the per-product shares, for tests and local runs. */
export function memoryNeuronBudget(shares: Record<NeuronProduct, number> = NEURON_SHARES): NeuronBudget & { used(product: NeuronProduct): number; open(): number } {
  const used: Record<NeuronProduct, number> = { agent: 0, ocr: 0, embeddings: 0, dictation: 0, speech: 0 };
  const open = new Map<string, { product: NeuronProduct; neurons: number }>();
  let n = 0;
  const inUse = (p: NeuronProduct) => used[p] + [...open.values()].filter((o) => o.product === p).reduce((a, o) => a + o.neurons, 0);
  return {
    async reserve(i) {
      const cur = inUse(i.product);
      if (cur + i.neurons > shares[i.product]) return { ok: false, code: "BUDGET_EXCEEDED", used: cur, cap: shares[i.product] };
      const id = `nrs_${++n}`;
      open.set(id, { product: i.product, neurons: i.neurons });
      return { ok: true, reservationId: id };
    },
    async settle(id, neurons) {
      const o = open.get(id);
      if (!o) return;
      open.delete(id);
      used[o.product] += neurons;
    },
    used: (p) => used[p],
    open: () => open.size,
  };
}

// Prices and bounds -------------------------------------------------------------------------------------------
// Every extra reserves an upper bound of what its call can cost before the call, and settles what the call reports
// (token usage, audio duration) after it, or the reservation when the reply reports nothing. A call that throws
// settles at its reservation: it may still have used neurons. Prices are Cloudflare's Workers AI pricing page as
// fetched on 2026-10-20.

/** UTF-8 length: a byte-level tokenizer never makes more tokens than a text has bytes. */
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** mistral-small-3.1-24b-instruct: neurons per million input and output tokens. */
export const OCR_NEURONS_PER_M = { input: 31_876, output: 50_488 } as const;
export const ocrNeurons = (inputTokens: number, outputTokens: number): number =>
  Math.ceil((Math.max(0, inputTokens) * OCR_NEURONS_PER_M.input + Math.max(0, outputTokens) * OCR_NEURONS_PER_M.output) / 1_000_000);
/**
 * The model's vision encoder cuts an image into 14 px patches and merges them 2 by 2, so an image costs one token per
 * 28 px square plus one break token per row (the model's processor configuration). Images reach the model at most
 * OCR_MAX_EDGE_PX on a side, so a read's image tokens are bounded by its dimensions.
 */
export const OCR_IMAGE_CELL_PX = 28;
export const ocrImageTokens = (width: number, height: number): number => {
  const cols = Math.ceil(Math.max(1, width) / OCR_IMAGE_CELL_PX), rows = Math.ceil(Math.max(1, height) / OCR_IMAGE_CELL_PX);
  return rows * cols + Math.max(rows, cols);
};
/** Chat template, role and image delimiter tokens around a prompt: an allowance, not a measurement. */
export const OCR_TEMPLATE_TOKENS = 64;

/** whisper-large-v3-turbo: 46.63 neurons per audio minute (design 5.4); a clip is at most 30 s. */
export const DICTATION_NEURONS_PER_MINUTE = 46.63;
export const dictationNeurons = (seconds: number): number => Math.ceil((Math.max(0, seconds) / 60) * DICTATION_NEURONS_PER_MINUTE);
/** A clip may run this much past DICTATION_MAX_SECONDS (a recorder stops a little late). */
export const DICTATION_SLACK_SECONDS = 0.5;
/** The most one accepted clip can cost. */
export const DICTATION_RESERVE_NEURONS = dictationNeurons(DICTATION_MAX_SECONDS + DICTATION_SLACK_SECONDS);

/** bge-base-en-v1.5: neurons per million input tokens. */
export const EMBEDDING_NEURONS_PER_M_TOKENS = 6058;
/** bge-base-en-v1.5 reads at most this many tokens of one text (Workers AI model page). */
export const EMBEDDING_MAX_TOKENS = 512;
/**
 * The most one text can cost in tokens: its WordPiece tokenizer never makes more tokens than the text has bytes, plus
 * the [CLS] and [SEP] tokens, and the model reads at most EMBEDDING_MAX_TOKENS. Workers AI reports no usage for
 * embeddings, so embedding calls reserve and settle this bound.
 */
export const embeddingTokenBound = (text: string): number => Math.min(EMBEDDING_MAX_TOKENS, utf8Length(text) + 2);
export const embeddingNeurons = (texts: readonly string[]): number =>
  Math.max(1, Math.ceil((texts.reduce((a, t) => a + embeddingTokenBound(t), 0) * EMBEDDING_NEURONS_PER_M_TOKENS) / 1_000_000));

/** Token usage from a Workers AI text generation reply (`usage` at the top or under `result`), or null. */
export function usageOf(out: unknown): { prompt: number; completion: number } | null {
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  const u = (o.usage ?? (o.result && typeof o.result === "object" ? (o.result as Record<string, unknown>).usage : undefined)) as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens), completion = Number(u.completion_tokens ?? u.output_tokens);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0 ? { prompt, completion } : null;
}

export const EXTRAS_MODELS = { ocr: OCR_MODEL, embeddings: EMBEDDING_MODEL, dictation: DICTATION_MODEL } as const;
