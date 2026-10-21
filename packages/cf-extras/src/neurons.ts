// Workers AI neurons for the extras (design 5.2 and 5.4). Weft's daily share is 5,000 of the account's 10,000:
// agent 4,000, OCR 500, embeddings 200, dictation 300 (NEURON_SHARES). SpendDO holds the neuron ledger, so every
// extra reserves its worst case before the call and settles what it used after; an open reservation counts as used,
// and an orphan settles at its reserved worst case. Track cf6-extras.
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
  const used: Record<NeuronProduct, number> = { agent: 0, ocr: 0, embeddings: 0, dictation: 0 };
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

// Estimates ------------------------------------------------------------------------------------------------------

/** One receipt read measured 10.1 neurons (probe, design 5.4); the reservation allows for a larger image or reply. */
export const OCR_NEURONS = { reserve: 25, measured: 10.1 } as const;
/** whisper-large-v3-turbo: 46.63 neurons per audio minute (design 5.4); a clip is at most 30 s. */
export const DICTATION_NEURONS_PER_MINUTE = 46.63;
export const dictationNeurons = (seconds: number): number => Math.ceil((Math.max(0, seconds) / 60) * DICTATION_NEURONS_PER_MINUTE);
export const DICTATION_RESERVE_NEURONS = dictationNeurons(DICTATION_MAX_SECONDS);
/**
 * bge-base-en-v1.5 input tokens priced at 6,058 neurons per million (research: Workers AI pricing). Tokens are
 * estimated at 4 characters each, rounded up, so the estimate errs toward the cap.
 */
export const EMBEDDING_NEURONS_PER_M_TOKENS = 6058;
export const embeddingNeurons = (texts: readonly string[]): number => Math.max(1, Math.ceil((texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0) * EMBEDDING_NEURONS_PER_M_TOKENS) / 1_000_000));

export const EXTRAS_MODELS = { ocr: OCR_MODEL, embeddings: EMBEDDING_MODEL, dictation: DICTATION_MODEL } as const;
