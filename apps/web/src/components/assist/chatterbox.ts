"use client";
// Chatterbox Nano in the browser (research/cursor-assistant.md 7.5): owensong/chatterbox-nano-ONNX (MIT, Resemble AI
// upstream) on ONNX Runtime Web's WebGPU build, pinned to one revision. Downloaded only when the person turns spoken
// answers on, once, with progress; the browser's Cache Storage keeps the files, so a later visit loads from disk. Only
// three of the four graphs are fetched (token embeddings, the language model and the decoder, about 392 MB): the
// speech encoder is skipped and the voice is the fixed one this server ships (chatterbox-core.ts voice file). The
// pipeline follows the model's own run_onnx.py: embed the text, prepend the voice's features, sample speech tokens
// with a KV cache until the stop token, then decode a 24 kHz waveform. Nothing leaves the browser.
import { applyRepetitionPenalty, concatSeq, decodeVoice, halvesToFloats, sampleToken, SAMPLE_RATE, SAMPLING, speechTokens, START_SPEECH, STOP_SPEECH, type VoiceTensor } from "./chatterbox-core";

export const VOICE_MODEL = {
  repo: "owensong/chatterbox-nano-ONNX",
  revision: "4a66d7dab72a9e98f24b515d49a1d7a81632df2e",
  files: {
    tokenizer: { path: "tokenizer.json", bytes: 3_560_000 },
    tokenizerConfig: { path: "tokenizer_config.json", bytes: 414 },
    embed: { path: "onnx/embed_tokens_fp16.onnx", bytes: 1_520 },
    embedData: { path: "onnx/embed_tokens_fp16.onnx_data", bytes: 87_300_000 },
    lm: { path: "onnx/language_model_q4f16.onnx", bytes: 522_000 },
    lmData: { path: "onnx/language_model_q4f16.onnx_data", bytes: 55_911_658 },
    decoder: { path: "onnx/conditional_decoder_q4.onnx", bytes: 2_180_000 },
    decoderData: { path: "onnx/conditional_decoder_q4.onnx_data", bytes: 246_000_000 },
  },
} as const;
/** About 395 MB in all (the speech encoder's 177 MB are never fetched). */
export const VOICE_MODEL_BYTES = Object.values(VOICE_MODEL.files).reduce((a, f) => a + f.bytes, 0);
/** The fixed voice, served by Weft itself (scripts/assist/build-voice.ts writes it). */
export const VOICE_FILE_URL = "/assist/voice/weft-voice.bin";
const CACHE = "weft-voice-v1";
const fileUrl = (path: string) => `https://huggingface.co/${VOICE_MODEL.repo}/resolve/${VOICE_MODEL.revision}/${path}`;

export class VoiceUnavailable extends Error {}

export interface Progress { loaded: number; total: number; file: string }

/** One file, from Cache Storage when it is there, else downloaded with progress and cached. */
async function cachedBytes(url: string, expect: number, onBytes: (n: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { cache = null; }
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onBytes(b.length); return b; }
  const res = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok || !res.body) throw new VoiceUnavailable(`The voice model file could not be downloaded (${res.status}).`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  if (expect > 1_000_000 && Math.abs(n - expect) / expect > 0.05) throw new VoiceUnavailable("The voice model file was not the size it should be.");
  await cache?.put(url, new Response(out, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
  return out;
}

/** Whether the files are in Cache Storage already (no download needed). */
export async function voiceModelCached(): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    for (const f of Object.values(VOICE_MODEL.files)) if (!(await cache.match(fileUrl(f.path)))) return false;
    return true;
  } catch { return false; }
}

/** Whether this server ships the fixed voice (a HEAD request to Weft's own origin). */
export async function voiceFileAvailable(): Promise<boolean> {
  try { return (await fetch(VOICE_FILE_URL, { method: "HEAD" })).ok; } catch { return false; }
}

type Ort = typeof import("onnxruntime-web");
type Session = import("onnxruntime-web").InferenceSession;
interface Loaded { ort: Ort; tok: { encode(t: string): { ids: number[] } }; embed: Session; lm: Session; decoder: Session; voice: Map<string, VoiceTensor> }
let loading: Promise<Loaded> | null = null;
/** Everyone waiting on the one shared load hears its progress until their own call settles. */
const listeners = new Set<(p: Progress) => void>();

/** Loads everything once (later calls share it); `onProgress` sees the download, which a cached load skips. */
export function loadChatterbox(onProgress: (p: Progress) => void): Promise<Loaded> {
  listeners.add(onProgress);
  loading ??= (async () => {
    if (!("gpu" in navigator)) throw new VoiceUnavailable("This browser has no WebGPU.");
    const vres = await fetch(VOICE_FILE_URL);
    if (!vres.ok) throw new VoiceUnavailable("The in-browser voice is not set up on this server.");
    const voice = decodeVoice(await vres.arrayBuffer());
    let loaded = 0;
    const total = VOICE_MODEL_BYTES;
    const get = (f: { path: string; bytes: number }) => cachedBytes(fileUrl(f.path), f.bytes, (n) => { loaded += n; for (const l of listeners) l({ loaded: Math.min(loaded, total), total, file: f.path }); });
    const F = VOICE_MODEL.files;
    // The JSPI build: its WebAssembly (about 17 MB) is the one that fits a static asset and runs WebGPU.
    const ort = (await import("onnxruntime-web/jspi")) as unknown as Ort;
    ort.env.wasm.numThreads = 1;
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const tokJson = JSON.parse(new TextDecoder().decode(await get(F.tokenizer))) as object;
    const tokCfg = JSON.parse(new TextDecoder().decode(await get(F.tokenizerConfig))) as object;
    const tok = new Tokenizer(tokJson, tokCfg) as unknown as Loaded["tok"];
    const session = async (graph: { path: string; bytes: number }, data: { path: string; bytes: number }) => {
      const [g, d] = [await get(graph), await get(data)];
      return ort.InferenceSession.create(g, { executionProviders: ["webgpu"], externalData: [{ path: data.path.split("/").pop()!, data: d }] });
    };
    const embed = await session(F.embed, F.embedData);
    const lm = await session(F.lm, F.lmData);
    const decoder = await session(F.decoder, F.decoderData);
    return { ort, tok, embed, lm, decoder, voice };
  })();
  loading.catch(() => { loading = null; });
  return loading.finally(() => listeners.delete(onProgress));
}

const tensorOf = (ort: Ort, t: VoiceTensor) => new ort.Tensor(t.dtype, t.data as never, t.dims);

/** The answer as a 24 kHz waveform. `rand` makes sampling repeatable in a test. */
export async function synthesize(m: Loaded, text: string, rand: () => number = Math.random): Promise<Float32Array> {
  const { ort } = m;
  const ids = m.tok.encode(text).ids;
  const run = async (s: Session, feeds: Record<string, import("onnxruntime-web").Tensor>) => s.run(feeds);
  const embedIds = async (xs: number[]) => (await run(m.embed, { [m.embed.inputNames[0]!]: new ort.Tensor("int64", BigInt64Array.from(xs.map(BigInt)), [1, xs.length]) }))[m.embed.outputNames[0]!]!;
  const af = m.voice.get("audio_features")!;
  let embeds = await embedIds(ids);
  // Step 0: the voice's features, then the text.
  const joined = concatSeq(af.data as Uint16Array | Float32Array, af.dims, embeds.data as Uint16Array | Float32Array, [...embeds.dims] as number[]);
  let inputs: import("onnxruntime-web").Tensor = new ort.Tensor(embeds.type as "float16" | "float32", joined.data as never, joined.dims);
  const pastNames = m.lm.inputNames.filter((n) => n.startsWith("past_key_values"));
  // The cache starts empty: [1, heads, 0, head_dim], from the graph's metadata where the runtime exposes it (run_onnx.py
  // reads the same shape; 12 heads of 64 when it is not given).
  const meta = (m.lm as unknown as { inputMetadata?: { name: string; type?: string; shape?: (number | string)[] }[] }).inputMetadata?.find((x) => x.name === pastNames[0]);
  const heads = typeof meta?.shape?.[1] === "number" ? meta.shape[1] : 12;
  const headDim = typeof meta?.shape?.[3] === "number" ? meta.shape[3] : 64;
  const halfKv = !meta?.type || /float16/.test(meta.type);
  let past: Record<string, import("onnxruntime-web").Tensor> = Object.fromEntries(pastNames.map((n) => [n, new ort.Tensor(halfKv ? "float16" : "float32", halfKv ? new Uint16Array(0) : new Float32Array(0), [1, heads, 0, headDim])]));
  let seq = joined.dims[1]!;
  let pos = Array.from({ length: seq }, (_, i) => BigInt(i));
  const generated = [START_SPEECH];
  for (let step = 0; step < SAMPLING.maxNewTokens; step++) {
    const total = pastNames.length ? (past[pastNames[0]!]!.dims[2] as number) + inputs.dims[1]! : inputs.dims[1]!;
    const out = await run(m.lm, {
      inputs_embeds: inputs,
      attention_mask: new ort.Tensor("int64", new BigInt64Array(total).fill(1n), [1, total]),
      position_ids: new ort.Tensor("int64", BigInt64Array.from(pos), [1, pos.length]),
      ...past,
    });
    const logitsT = out[m.lm.outputNames[0]!]!;
    const vocab = logitsT.dims[2]!;
    const last = logitsT.type === "float16" ? halvesToFloats((logitsT.data as Uint16Array).subarray((logitsT.dims[1]! - 1) * vocab)) : (logitsT.data as Float32Array).slice((logitsT.dims[1]! - 1) * vocab);
    applyRepetitionPenalty(last, generated, SAMPLING.repetitionPenalty);
    const next = sampleToken(last, SAMPLING, rand);
    generated.push(next);
    if (next === STOP_SPEECH) break;
    // The cache: outputs after the logits replace the past inputs in order.
    const presents = m.lm.outputNames.slice(1);
    past = Object.fromEntries(pastNames.map((n, i) => [n, out[presents[i]!]!]));
    embeds = await embedIds([next]);
    inputs = embeds;
    seq += 1;
    pos = [BigInt(seq - 1)];
  }
  const tokens = speechTokens(m.voice.get("audio_tokens")!.data as BigInt64Array, generated);
  const dec = await run(m.decoder, {
    speech_tokens: new ort.Tensor("int64", tokens, [1, tokens.length]),
    speaker_embeddings: tensorOf(ort, m.voice.get("speaker_embeddings")!),
    speaker_features: tensorOf(ort, m.voice.get("speaker_features")!),
  });
  const wav = dec[m.decoder.outputNames[0]!]!;
  return wav.type === "float16" ? halvesToFloats(wav.data as Uint16Array) : Float32Array.from(wav.data as Float32Array);
}

/** Plays a waveform; resolves when it ends or `signal` stops it. */
export async function playWave(samples: Float32Array, signal?: AbortSignal, rate = SAMPLE_RATE): Promise<void> {
  // A signal stopped before playback starts plays nothing (an abort listener added now would never fire).
  if (signal?.aborted) return;
  const ctx = new AudioContext({ sampleRate: rate });
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  await new Promise<void>((resolve) => {
    src.onended = () => resolve();
    signal?.addEventListener("abort", () => { try { src.stop(); } catch { /* ended */ } resolve(); }, { once: true });
    src.start();
  });
  await ctx.close().catch(() => undefined);
}
