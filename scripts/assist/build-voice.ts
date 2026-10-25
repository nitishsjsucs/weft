// Builds the cursor assistant's fixed voice (apps/web/public/assist/voice/weft-voice.bin, the WEFTVOICE1 file
// chatterbox-core.ts decodes; research/cursor-assistant.md 7.5) from Resemble AI's built-in default voice: conds.pt in
// ResembleAI/chatterbox-nano (MIT), which upstream Chatterbox loads whenever it is given no reference clip. conds.pt
// holds precomputed conditioning, not audio, so no clip and no speech encoder run are involved:
//   audio_tokens       i64[1,250]      gen.prompt_token
//   speaker_embeddings f32[1,192]      gen.embedding
//   speaker_features   f32[1,500,80]   gen.prompt_feat
//   audio_features     f32[1,376,768]  the speech encoder's constant speaker row (owensong's conversion bakes it into
//                                      speech_encoder_q4f16.onnx_data), then speech_emb.weight's row for each of
//                                      t3.cond_prompt_speech_tokens' 375 ids (embed_tokens_fp16.onnx_data)
// Nothing downloaded is run or unpickled: conds.pt is a zip of raw little-endian storages read by byte length, its
// pickle is only scanned for which storage holds which tensor, and the two ONNX rows come from HTTP byte ranges of the
// pinned files. Every file is pinned by revision and checked by size and sha256 (the ONNX repo's own SHA256SUMS);
// a ranged read checks the whole file's size and hash as the server states them, and the slice's own sha256.
// --full downloads both ONNX data files whole instead (about 264 MB) and checks their sha256 itself. Either way the
// build then reads the first 21 MB of the official t3_nano_v1.safetensors and checks the speaker row against
// spkr_enc(t3.speaker_emb) and the speech rows against its float32 table (both agree within 2e-3).
//
//   pnpm voice:build [--full]
//
// Downloads go to a fresh directory under .scratch (never staged). Writes the voice file and its provenance sidecar.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { encodeVoice, halvesToFloats, type VoiceTensor } from "../../apps/web/src/components/assist/chatterbox-core";

const ROOT = resolve(import.meta.dirname, "../..");
export const VOICE_OUT = "apps/web/public/assist/voice/weft-voice.bin";
export const PROVENANCE_OUT = "apps/web/public/assist/voice/weft-voice.provenance.json";

const HF = "https://huggingface.co";
export const CONDS = {
  repo: "ResembleAI/chatterbox-nano",
  revision: "71ccd1d0081b430592cea481f4307e764e07bc64",
  path: "conds.pt",
  bytes: 169_454,
  sha256: "b1852099306fd6a7814eb9d0bd10186caba7249596cc23868f78a0eefbfa5033",
} as const;
/** The official float32 weights the result is checked against. */
export const T3 = {
  repo: CONDS.repo,
  revision: CONDS.revision,
  path: "t3_nano_v1.safetensors",
  bytes: 869_899_204,
  sha256: "72b110185087d945dbdf54dee4e333848e1811bdd5fd6cb16ceb8da50006f0c9",
} as const;
export const ONNX = {
  repo: "owensong/chatterbox-nano-ONNX",
  revision: "4a66d7dab72a9e98f24b515d49a1d7a81632df2e",
  /** SHA256SUMS at this revision, as the repo publishes it. */
  sums: { path: "SHA256SUMS", bytes: 1_708 },
  embedGraph: { path: "onnx/embed_tokens_fp16.onnx", bytes: 1_520, sha256: "019d257243774091d78c2ad91c2c0f61e4e442740cb7b3b00b5a89109417b18d" },
  embedData: { path: "onnx/embed_tokens_fp16.onnx_data", bytes: 87_304_704, sha256: "bcd7b35ae4f206932e2491cb60b42ebb80f6d8facfdb53ba7d7449ad00a3237b" },
  encoderGraph: { path: "onnx/speech_encoder_q4f16.onnx", bytes: 1_219_352, sha256: "29e249f59eaf95015527588b955e5286c7ee4524e7bb54a2f8d589b838e8aed2" },
  encoderData: { path: "onnx/speech_encoder_q4f16.onnx_data", bytes: 176_273_652, sha256: "55d89bd87fd36be48b2e831c99c2e309d432169119049066f9f22fcfe517798d" },
} as const;
export const HIDDEN = 768;
export const SPEECH_VOCAB = 6563;
/** The two slices the voice takes from the ONNX data files: where they are, and their own sha256 (pinned here). */
export const SLICES = {
  speakerRow: { file: ONNX.encoderData, offset: 3_840, bytes: HIDDEN * 2, sha256: "b85fe6f914ec8fc0b4f3c7c7a116d3b0ed29facc1e3330819a5cceb5cbcf1670" },
  speechEmb: { file: ONNX.embedData, offset: 77_223_936, bytes: SPEECH_VOCAB * HIDDEN * 2, sha256: "9d7c3b3ba82b6433db6ddd04600bcfac2b567750e8738622f640b1a0564cf457" },
} as const;
/** conds.pt's storages: the tensor each holds and its size in bytes (count times 8 for int64, 4 for float32). */
export const CONDS_TENSORS = {
  speakerEmb: { name: "speaker_emb", dtype: "float32", dims: [1, 256] },
  condTokens: { name: "cond_prompt_speech_tokens", dtype: "int64", dims: [1, 375] },
  promptToken: { name: "prompt_token", dtype: "int64", dims: [1, 250] },
  promptFeat: { name: "prompt_feat", dtype: "float32", dims: [1, 500, 80] },
  embedding: { name: "embedding", dtype: "float32", dims: [1, 192] },
} as const;

export const resolveUrl = (f: { repo: string; revision: string; path: string }) => `${HF}/${f.repo}/resolve/${f.revision}/${f.path}`;
export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const byteSize = (dtype: "float32" | "int64") => (dtype === "int64" ? 8 : 4);
export const tensorBytes = (t: { dtype: "float32" | "int64"; dims: readonly number[] }) => t.dims.reduce((a, b) => a * b, 1) * byteSize(t.dtype);

// ---- conds.pt: a torch zip -----------------------------------------------------------------------------------

/** The stored (uncompressed) entries of a zip, read from its central directory; a compressed entry is refused. */
export function zipEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("zip central directory is malformed");
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const usize = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0 || size !== usize) throw new Error(`zip entry ${name} is compressed`);
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`zip entry ${name} has no local header`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + size > zip.length) throw new Error(`zip entry ${name} runs past the file`);
    out.set(name, zip.subarray(start, start + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Which storage key holds each named tensor in a torch pickle, without unpickling it: the pickle's short unicode
 * strings in order, where a tensor's name is followed by its storage's key (a decimal string) before the next name.
 */
export function pickleStorageKeys(pkl: Uint8Array, names: readonly string[]): Map<string, string> {
  const strings: string[] = [];
  for (let i = 0; i + 5 <= pkl.length; i++) {
    if (pkl[i] !== 0x58) continue;   // BINUNICODE: 'X', a 4-byte little-endian length, then UTF-8
    const len = pkl[i + 1]! | (pkl[i + 2]! << 8) | (pkl[i + 3]! << 16) | (pkl[i + 4]! << 24);
    if (len < 1 || len > 64 || i + 5 + len > pkl.length) continue;
    const s = new TextDecoder("utf-8", { fatal: false }).decode(pkl.subarray(i + 5, i + 5 + len));
    if (!/^[\w.:]+$/.test(s)) continue;
    strings.push(s);
    i += 4 + len;
  }
  const out = new Map<string, string>();
  for (const n of names) {
    const at = strings.indexOf(n);
    if (at < 0) throw new Error(`the pickle names no ${n}`);
    const key = strings.slice(at + 1).find((s) => /^\d+$/.test(s) || names.includes(s));
    if (!key || !/^\d+$/.test(key)) throw new Error(`the pickle gives ${n} no storage`);
    out.set(n, key);
  }
  return out;
}

export interface CondsTensors { speakerEmb: Float32Array; condTokens: BigInt64Array; promptToken: BigInt64Array; promptFeat: Float32Array; embedding: Float32Array }

/** The five tensors the voice needs from conds.pt, each checked by its storage's byte length and a little-endian file. */
export function readConds(zip: Uint8Array): CondsTensors {
  const entries = zipEntries(zip);
  const entry = (suffix: string) => [...entries].find(([n]) => n.endsWith(`/${suffix}`))?.[1];
  const order = entry("byteorder");
  if (!order || new TextDecoder().decode(order) !== "little") throw new Error("conds.pt is not little-endian");
  const pkl = entry("data.pkl");
  if (!pkl) throw new Error("conds.pt has no data.pkl");
  const keys = pickleStorageKeys(pkl, Object.values(CONDS_TENSORS).map((t) => t.name));
  const read = <K extends keyof CondsTensors>(k: K): CondsTensors[K] => {
    const t = CONDS_TENSORS[k];
    const raw = entry(`data/${keys.get(t.name)!}`);
    if (!raw) throw new Error(`conds.pt lacks the storage of ${t.name}`);
    if (raw.length !== tensorBytes(t)) throw new Error(`${t.name} holds ${raw.length} bytes, not ${tensorBytes(t)}`);
    const copy = raw.slice().buffer;
    return (t.dtype === "int64" ? new BigInt64Array(copy) : new Float32Array(copy)) as CondsTensors[K];
  };
  return { speakerEmb: read("speakerEmb"), condTokens: read("condTokens"), promptToken: read("promptToken"), promptFeat: read("promptFeat"), embedding: read("embedding") };
}

// ---- ONNX graphs: where an initializer's bytes are -----------------------------------------------------------

export interface Initializer { name: string; dataType: number; dims: number[]; location?: string; offset?: number; length?: number }

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0, mul = 1, i = at;
  for (;;) {
    const x = b[i++]!;
    v += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [v, i];
    mul *= 128;
  }
}
/** A protobuf message's fields as [field number, wire type, value or bytes]. */
function fields(b: Uint8Array): [number, number, number | Uint8Array][] {
  const out: [number, number, number | Uint8Array][] = [];
  let i = 0;
  while (i < b.length) {
    const [tag, a] = varint(b, i);
    i = a;
    const f = Math.floor(tag / 8), w = tag & 7;
    if (w === 0) { const [v, n] = varint(b, i); out.push([f, w, v]); i = n; }
    else if (w === 2) { const [len, n] = varint(b, i); out.push([f, w, b.subarray(n, n + len)]); i = n + len; }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error(`protobuf wire type ${w} is not read here`);
  }
  return out;
}
/** A graph file's initializers (ModelProto.graph = 7, GraphProto.initializer = 5) with their external data entries. */
export function onnxInitializers(model: Uint8Array): Initializer[] {
  const graph = fields(model).find(([f, w]) => f === 7 && w === 2)?.[2];
  if (!(graph instanceof Uint8Array)) throw new Error("the ONNX file has no graph");
  const out: Initializer[] = [];
  for (const [f, w, t] of fields(graph)) {
    if (f !== 5 || w !== 2 || !(t instanceof Uint8Array)) continue;
    const init: Initializer = { name: "", dataType: 0, dims: [] };
    for (const [tf, tw, tv] of fields(t)) {
      if (tf === 1 && tw === 0) init.dims.push(tv as number);
      else if (tf === 1 && tw === 2) { const p = tv as Uint8Array; for (let i = 0; i < p.length;) { const [d, n] = varint(p, i); init.dims.push(d); i = n; } }
      else if (tf === 2) init.dataType = tv as number;
      else if (tf === 8) init.name = new TextDecoder().decode(tv as Uint8Array);
      else if (tf === 13) {
        const kv = Object.fromEntries(fields(tv as Uint8Array).map(([, , x]) => x).reduce<string[][]>((a, x, i) => { if (i % 2 === 0) a.push([]); a[a.length - 1]!.push(new TextDecoder().decode(x as Uint8Array)); return a; }, []));
        if (kv.location) init.location = kv.location;
        if (kv.offset) init.offset = Number(kv.offset);
        if (kv.length) init.length = Number(kv.length);
      }
    }
    out.push(init);
  }
  return out;
}
export const FLOAT16 = 10;
/** The one external fp16 initializer at exactly this offset and length in the data file. */
export function initializerAt(inits: readonly Initializer[], location: string, offset: number, length: number): Initializer {
  const hit = inits.filter((i) => i.location === location && i.offset === offset && i.length === length);
  if (hit.length !== 1) throw new Error(`${hit.length} initializers at ${location} offset ${offset} length ${length}, not one`);
  if (hit[0]!.dataType !== FLOAT16) throw new Error(`${hit[0]!.name} is data type ${hit[0]!.dataType}, not float16`);
  return hit[0]!;
}

// ---- the voice -----------------------------------------------------------------------------------------------

/** [speaker row ; speech_emb row of each cond token], as float32 [1, 1 + tokens, HIDDEN]. */
export function audioFeatures(speakerRowF16: Uint16Array, speechEmbF16: Uint16Array, tokens: BigInt64Array): Float32Array {
  if (speakerRowF16.length !== HIDDEN) throw new Error(`the speaker row holds ${speakerRowF16.length} values, not ${HIDDEN}`);
  const vocab = speechEmbF16.length / HIDDEN;
  if (!Number.isInteger(vocab)) throw new Error("the speech embedding table is not whole rows");
  const out = new Float32Array((1 + tokens.length) * HIDDEN);
  out.set(halvesToFloats(speakerRowF16), 0);
  tokens.forEach((t, i) => {
    const id = Number(t);
    if (id < 0 || id >= vocab) throw new Error(`cond token ${id} is outside the ${vocab}-row table`);
    out.set(halvesToFloats(speechEmbF16.subarray(id * HIDDEN, (id + 1) * HIDDEN)), (1 + i) * HIDDEN);
  });
  return out;
}

/** The four tensors of the voice file, in chatterbox-core.ts VOICE_TENSORS order. */
export function voiceTensors(c: CondsTensors, speakerRowF16: Uint16Array, speechEmbF16: Uint16Array): VoiceTensor[] {
  return [
    { name: "audio_features", dtype: "float32", dims: [1, 1 + c.condTokens.length, HIDDEN], data: audioFeatures(speakerRowF16, speechEmbF16, c.condTokens) },
    { name: "audio_tokens", dtype: "int64", dims: [1, c.promptToken.length], data: c.promptToken },
    { name: "speaker_embeddings", dtype: "float32", dims: [1, c.embedding.length], data: c.embedding },
    { name: "speaker_features", dtype: "float32", dims: [1, c.promptFeat.length / 80, 80], data: c.promptFeat },
  ];
}

/** SHA256SUMS lines ("<hex>  <path>") as a map. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) { const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim()); if (m) out.set(m[2]!, m[1]!); }
  return out;
}

const halves = (b: Uint8Array) => new Uint16Array(b.slice().buffer);

// ---- downloads -----------------------------------------------------------------------------------------------

/** A whole pinned file, checked by size and sha256. */
async function fetchWhole(url: string, bytes: number, hash: string | null): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length !== bytes) throw new Error(`${url} is ${b.length} bytes, not ${bytes}`);
  if (hash && sha256(b) !== hash) throw new Error(`${url} does not have sha256 ${hash}`);
  return b;
}

/**
 * Bytes [offset, offset + length) of a pinned file. The resolver's first answer states the whole file's size and
 * sha256 (X-Linked-Size, X-Linked-ETag), checked against the pins before the range is read from where it redirects.
 */
async function fetchRange(url: string, f: { bytes: number; sha256: string }, offset: number, length: number): Promise<Uint8Array> {
  const head = await fetch(url, { method: "HEAD", redirect: "manual" });
  const size = Number(head.headers.get("x-linked-size"));
  const etag = (head.headers.get("x-linked-etag") ?? "").replace(/"/g, "");
  if (size !== f.bytes) throw new Error(`${url} is stated as ${size} bytes, not ${f.bytes}`);
  if (etag !== f.sha256) throw new Error(`${url} is stated with sha256 ${etag}, not ${f.sha256}`);
  const res = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, redirect: "follow" });
  if (res.status !== 206) throw new Error(`range GET ${url}: ${res.status}, not 206`);
  const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]);
  if (total !== f.bytes) throw new Error(`${url}'s range answer says the file is ${total} bytes, not ${f.bytes}`);
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length !== length) throw new Error(`range GET ${url} returned ${b.length} bytes, not ${length}`);
  return b;
}

/**
 * How far the voice's audio_features are from the official float32 weights: its first row from spkr_enc(speaker_emb)
 * (Linear 256 to 768, weight [768, 256]), and the others from speech_emb.weight's rows for the cond tokens.
 */
export function crossCheck(af: Float32Array, c: Pick<CondsTensors, "speakerEmb" | "condTokens">, w: { bias: Float32Array; weight: Float32Array; table: Float32Array }): { speakerRowMaxDiff: number; speechRowsMaxDiff: number } {
  const inDim = c.speakerEmb.length;
  let d0 = 0, d1 = 0;
  for (let o = 0; o < HIDDEN; o++) {
    let s = w.bias[o]!;
    for (let i = 0; i < inDim; i++) s += w.weight[o * inDim + i]! * c.speakerEmb[i]!;
    d0 = Math.max(d0, Math.abs(s - af[o]!));
  }
  c.condTokens.forEach((t, r) => { for (let o = 0; o < HIDDEN; o++) d1 = Math.max(d1, Math.abs(w.table[Number(t) * HIDDEN + o]! - af[(1 + r) * HIDDEN + o]!)); });
  return { speakerRowMaxDiff: d0, speechRowsMaxDiff: d1 };
}
export const CROSS_CHECK_TOLERANCE = 2e-3;

/** The official spkr_enc and speech_emb.weight, from a range read of the safetensors file's header and first tensors. */
async function officialWeights(): Promise<{ bias: Float32Array; weight: Float32Array; table: Float32Array }> {
  const url = resolveUrl(T3);
  const n = Number(new DataView((await fetchRange(url, T3, 0, 8)).buffer).getBigUint64(0, true));
  if (n > 1_000_000) throw new Error(`${T3.path} states a ${n}-byte header`);
  const meta = JSON.parse(new TextDecoder().decode(await fetchRange(url, T3, 8, n))) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const want = { bias: ["cond_enc.spkr_enc.bias", [HIDDEN]], weight: ["cond_enc.spkr_enc.weight", [HIDDEN, 256]], table: ["speech_emb.weight", [SPEECH_VOCAB, HIDDEN]] } as const;
  for (const [k, shape] of Object.values(want)) {
    const t = meta[k];
    if (!t || t.dtype !== "F32" || t.shape.join() !== shape.join()) throw new Error(`${T3.path} has no F32 ${k} [${shape.join(", ")}]`);
  }
  const end = Math.max(...Object.values(want).map(([k]) => meta[k]!.data_offsets[1]));
  if (end > 32_000_000) throw new Error(`${T3.path}'s tensors are not where they were (${end} bytes in)`);
  const body = await fetchRange(url, T3, 8 + n, end);
  const f32 = (k: string) => { const [a, b] = meta[k]!.data_offsets; return new Float32Array(body.slice(a, b).buffer); };
  return { bias: f32(want.bias[0]), weight: f32(want.weight[0]), table: f32(want.table[0]) };
}

async function main(argv: string[]): Promise<void> {
  const full = argv.includes("--full");
  const work = join(ROOT, ".scratch", `voice-build-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(work)) throw new Error(`${work} exists already`);
  mkdirSync(work, { recursive: true });
  const keep = (name: string, b: Uint8Array) => writeFileSync(join(work, name.replace(/\//g, "_")), b);
  const log = (s: string) => process.stdout.write(`${s}\n`);
  log(`downloads: ${relative(ROOT, work)}`);

  const conds = await fetchWhole(resolveUrl(CONDS), CONDS.bytes, CONDS.sha256);
  keep(CONDS.path, conds);
  const c = readConds(conds);
  log(`conds.pt: sha256 ok; ${c.condTokens.length} cond tokens, ${c.promptToken.length} prompt tokens`);

  const sums = parseSums(new TextDecoder().decode(await fetchWhole(resolveUrl({ ...ONNX, path: ONNX.sums.path }), ONNX.sums.bytes, null)));
  for (const f of [ONNX.embedGraph, ONNX.embedData, ONNX.encoderGraph, ONNX.encoderData]) {
    if (sums.get(f.path) !== f.sha256) throw new Error(`SHA256SUMS gives ${f.path} ${sums.get(f.path) ?? "nothing"}, not the pinned ${f.sha256}`);
  }
  const embedGraph = await fetchWhole(resolveUrl({ ...ONNX, path: ONNX.embedGraph.path }), ONNX.embedGraph.bytes, ONNX.embedGraph.sha256);
  const encoderGraph = await fetchWhole(resolveUrl({ ...ONNX, path: ONNX.encoderGraph.path }), ONNX.encoderGraph.bytes, ONNX.encoderGraph.sha256);
  keep(ONNX.embedGraph.path, embedGraph);
  keep(ONNX.encoderGraph.path, encoderGraph);
  const base = (p: string) => p.split("/").pop()!;
  const S = SLICES;
  const rowInit = initializerAt(onnxInitializers(encoderGraph), base(S.speakerRow.file.path), S.speakerRow.offset, S.speakerRow.bytes);
  const embInit = initializerAt(onnxInitializers(embedGraph), base(S.speechEmb.file.path), S.speechEmb.offset, S.speechEmb.bytes);
  if (embInit.dims.join() !== `${SPEECH_VOCAB},${HIDDEN}`) throw new Error(`${embInit.name} is [${embInit.dims.join(", ")}], not [${SPEECH_VOCAB}, ${HIDDEN}]`);
  log(`graphs: sha256 ok; speaker row ${rowInit.name} [${rowInit.dims.join(", ")}], speech table ${embInit.name} [${embInit.dims.join(", ")}]`);

  const slice = async (s: (typeof SLICES)[keyof typeof SLICES]) => {
    let b: Uint8Array;
    if (full) {
      const whole = await fetchWhole(resolveUrl({ ...ONNX, path: s.file.path }), s.file.bytes, s.file.sha256);
      b = whole.slice(s.offset, s.offset + s.bytes);
    } else b = await fetchRange(resolveUrl({ ...ONNX, path: s.file.path }), s.file, s.offset, s.bytes);
    const h = sha256(b);
    if (h !== s.sha256) throw new Error(`the slice of ${s.file.path} at ${s.offset} has sha256 ${h}, not ${s.sha256}`);
    keep(`${s.file.path}.${s.offset}-${s.offset + s.bytes}`, b);
    return { bytes: b, sha256: h };
  };
  const row = await slice(S.speakerRow);
  const emb = await slice(S.speechEmb);
  log(`slices: ${full ? "whole files" : "ranges"}, sha256 ${row.sha256.slice(0, 12)} and ${emb.sha256.slice(0, 12)}`);
  const tensors = voiceTensors(c, halves(row.bytes), halves(emb.bytes));

  const check = crossCheck(tensors[0]!.data as Float32Array, c, await officialWeights());
  if (check.speakerRowMaxDiff > CROSS_CHECK_TOLERANCE || check.speechRowsMaxDiff > CROSS_CHECK_TOLERANCE) throw new Error(`cross-check failed: speaker row off by ${check.speakerRowMaxDiff}, speech rows by ${check.speechRowsMaxDiff}`);
  log(`cross-check: speaker row within ${check.speakerRowMaxDiff.toExponential(2)}, speech rows within ${check.speechRowsMaxDiff.toExponential(2)} of ${T3.path}`);

  const file = encodeVoice(tensors);
  mkdirSync(join(ROOT, "apps/web/public/assist/voice"), { recursive: true });
  writeFileSync(join(ROOT, VOICE_OUT), file);
  const provenance = {
    voice: "Resemble AI built-in default voice, MIT; speaker not documented",
    file: { path: VOICE_OUT, bytes: file.length, sha256: sha256(file) },
    tensors: tensors.map((t) => ({ name: t.name, dtype: t.dtype, dims: t.dims })),
    sources: [
      { repo: CONDS.repo, revision: CONDS.revision, path: CONDS.path, bytes: CONDS.bytes, sha256: CONDS.sha256, license: "MIT", used: "gen.prompt_token, gen.embedding, gen.prompt_feat, t3.cond_prompt_speech_tokens" },
      { repo: ONNX.repo, revision: ONNX.revision, path: S.speakerRow.file.path, bytes: S.speakerRow.file.bytes, sha256: S.speakerRow.file.sha256, license: "MIT", used: `${rowInit.name}: bytes ${S.speakerRow.offset} to ${S.speakerRow.offset + S.speakerRow.bytes}, sha256 ${row.sha256}` },
      { repo: ONNX.repo, revision: ONNX.revision, path: S.speechEmb.file.path, bytes: S.speechEmb.file.bytes, sha256: S.speechEmb.file.sha256, license: "MIT", used: `${embInit.name}: bytes ${S.speechEmb.offset} to ${S.speechEmb.offset + S.speechEmb.bytes}, sha256 ${emb.sha256}` },
    ],
    crossCheck: { repo: T3.repo, revision: T3.revision, path: T3.path, sha256: T3.sha256, ...check },
    builtBy: "scripts/assist/build-voice.ts",
  };
  writeFileSync(join(ROOT, PROVENANCE_OUT), `${JSON.stringify(provenance, null, 2)}\n`);
  log(`wrote ${VOICE_OUT} (${file.length} bytes, sha256 ${provenance.file.sha256}) and ${PROVENANCE_OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { process.stderr.write(`build-voice: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
