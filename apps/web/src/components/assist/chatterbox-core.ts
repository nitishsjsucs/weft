// Chatterbox Nano in the browser, the pure parts (owensong/chatterbox-nano-ONNX, MIT; its run_onnx.py is the
// reference): sampling with a repetition penalty, temperature, top-k and top-p; the speech token sequence the decoder
// takes; half floats; and the fixed voice file. The voice file holds what the speech encoder would compute from a
// reference clip (audio_features, audio_tokens, speaker_embeddings, speaker_features), so the browser never downloads
// or runs the encoder: scripts/assist/build-voice.ts writes it once from a clip Weft has the rights to.
export const SAMPLE_RATE = 24_000;
export const START_SPEECH = 6561;
export const STOP_SPEECH = 6562;
export const SILENCE = 4299;
export const SAMPLING = { temperature: 0.8, topK: 1000, topP: 0.95, repetitionPenalty: 1.2, maxNewTokens: 256 } as const;

/** Run_onnx.py's repetition penalty: a token already generated has a negative logit multiplied, a positive one divided. */
export function applyRepetitionPenalty(logits: Float32Array, generated: readonly number[], penalty: number): void {
  for (const t of new Set(generated)) {
    if (t < 0 || t >= logits.length) continue;
    const v = logits[t]!;
    logits[t] = v < 0 ? v * penalty : v / penalty;
  }
}

/** One token: temperature, top-k, softmax, then top-p (a token stays while the probability before it is below p). */
export function sampleToken(logits: Float32Array, o: { temperature: number; topK: number; topP: number }, rand: () => number): number {
  const idx = Array.from(logits.keys()).sort((a, b) => logits[b]! - logits[a]!).slice(0, Math.max(1, o.topK));
  const t = Math.max(1e-5, o.temperature);
  const max = logits[idx[0]!]! / t;
  const exps = idx.map((i) => Math.exp(logits[i]! / t - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sum);
  let cum = 0;
  const keep: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    if (cum >= o.topP && keep.length) break;
    keep.push(k);
    cum += probs[k]!;
  }
  const total = keep.reduce((a, k) => a + probs[k]!, 0);
  let r = rand() * total;
  for (const k of keep) { r -= probs[k]!; if (r <= 0) return idx[k]!; }
  return idx[keep[keep.length - 1]!]!;
}

/** The decoder's speech tokens: the voice's prompt tokens, the generated tokens (start and stop removed), three silences. */
export function speechTokens(prompt: ArrayLike<bigint | number>, generated: readonly number[]): BigInt64Array {
  const body = generated.slice(1).filter((t, i, a) => !(t === STOP_SPEECH && i === a.length - 1));
  const out = new BigInt64Array(prompt.length + body.length + 3);
  for (let i = 0; i < prompt.length; i++) out[i] = BigInt(prompt[i]!);
  body.forEach((t, i) => { out[prompt.length + i] = BigInt(t); });
  for (let i = 0; i < 3; i++) out[prompt.length + body.length + i] = BigInt(SILENCE);
  return out;
}

/** IEEE 754 half to single precision. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
export function halvesToFloats(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = halfToFloat(h[i]!);
  return out;
}

// ---- the fixed voice file ---------------------------------------------------------------------------------------
// "WEFTVOICE1\n", a 4-byte little-endian header length, a JSON header { tensors: [{ name, dtype, dims, offset, bytes }] },
// then the tensor bytes (offsets from the start of the data section).

export type VoiceDtype = "float32" | "float16" | "int64";
export interface VoiceTensor { name: string; dtype: VoiceDtype; dims: number[]; data: Float32Array | Uint16Array | BigInt64Array }
export const VOICE_MAGIC = "WEFTVOICE1\n";
export const VOICE_TENSORS = ["audio_features", "audio_tokens", "speaker_embeddings", "speaker_features"] as const;

export function encodeVoice(tensors: readonly VoiceTensor[]): Uint8Array {
  let offset = 0;
  const meta = tensors.map((t) => { const bytes = t.data.byteLength; const m = { name: t.name, dtype: t.dtype, dims: t.dims, offset, bytes }; offset += bytes; return m; });
  const header = new TextEncoder().encode(JSON.stringify({ tensors: meta }));
  const magic = new TextEncoder().encode(VOICE_MAGIC);
  const out = new Uint8Array(magic.length + 4 + header.length + offset);
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(magic.length, header.length, true);
  out.set(header, magic.length + 4);
  const base = magic.length + 4 + header.length;
  for (const [i, t] of tensors.entries()) out.set(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength), base + meta[i]!.offset);
  return out;
}

export function decodeVoice(buf: ArrayBuffer): Map<string, VoiceTensor> {
  const bytes = new Uint8Array(buf);
  const magic = new TextEncoder().encode(VOICE_MAGIC);
  if (bytes.length < magic.length + 4 || !magic.every((b, i) => bytes[i] === b)) throw new Error("not a Weft voice file");
  const len = new DataView(buf).getUint32(magic.length, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(magic.length + 4, magic.length + 4 + len))) as { tensors: { name: string; dtype: VoiceDtype; dims: number[]; offset: number; bytes: number }[] };
  const base = magic.length + 4 + len;
  const out = new Map<string, VoiceTensor>();
  for (const t of header.tensors) {
    const slice = buf.slice(base + t.offset, base + t.offset + t.bytes);
    const data = t.dtype === "float32" ? new Float32Array(slice) : t.dtype === "float16" ? new Uint16Array(slice) : new BigInt64Array(slice);
    const count = t.dims.reduce((a, b) => a * b, 1);
    if (data.length !== count) throw new Error(`voice tensor ${t.name} holds ${data.length} values, not ${count}`);
    out.set(t.name, { name: t.name, dtype: t.dtype, dims: t.dims, data });
  }
  for (const n of VOICE_TENSORS) if (!out.has(n)) throw new Error(`voice file lacks ${n}`);
  return out;
}

/** Concatenates two [1, T, H] tensors of the same type along T (the voice's features before the text embeddings). */
export function concatSeq<T extends Float32Array | Uint16Array>(a: T, aDims: number[], b: T, bDims: number[]): { data: T; dims: number[] } {
  if (aDims.length !== 3 || bDims.length !== 3 || aDims[2] !== bDims[2]) throw new Error("concatSeq takes [1, T, H] tensors with the same H");
  const C = a.constructor as { new (n: number): T };
  const out = new C(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return { data: out, dims: [1, aDims[1]! + bDims[1]!, aDims[2]!] };
}
