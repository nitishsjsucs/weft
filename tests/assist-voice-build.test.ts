// The pure parts behind `pnpm voice:build` (scripts/assist/build-voice.ts), on synthetic bytes only: a stored zip's
// entries, which storage a torch pickle gives each tensor (scanned, never unpickled), conds.pt's tensors checked by
// byte length, an ONNX graph's external initializers, the voice's audio_features from the speaker row and the speech
// table, the four tensors in the voice file's order, SHA256SUMS, and the cross-check against float32 weights.
import { describe, expect, it } from "vitest";
import {
  audioFeatures, CONDS_TENSORS, crossCheck, FLOAT16, HIDDEN, initializerAt, onnxInitializers, parseSums, pickleStorageKeys, readConds, resolveUrl,
  tensorBytes, voiceTensors, zipEntries, type CondsTensors,
} from "../scripts/assist/build-voice";
import { decodeVoice, encodeVoice, VOICE_TENSORS } from "../apps/web/src/components/assist/chatterbox-core";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

/** A zip of stored entries (CRCs left zero: the reader does not check them). */
function zip(entries: [string, Uint8Array][], method = 0): Uint8Array {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = enc(name);
    const local = cat(u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(n.length), u16(0), n, data);
    centrals.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), n));
    locals.push(local);
    offset += local.length;
  }
  const cd = cat(...centrals);
  return cat(...locals, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0));
}
/** A pickle-like run: each string as BINUNICODE, with other opcodes' bytes between. */
const pickle = (...strings: string[]) => cat(new Uint8Array([0x80, 0x02]), ...strings.flatMap((s) => [new Uint8Array([0x71, 0x01]), new Uint8Array([0x58]), u32(enc(s).length), enc(s)]), new Uint8Array([0x2e]));

/** conds.pt's layout at a smaller size is not possible (its byte lengths are checked), so this is the real shape. */
function conds(over: Partial<Record<string, Uint8Array>> = {}): Uint8Array {
  const pkl = pickle("t3", "speaker_emb", "storage", "0", "cuda:0", "clap_emb", "cond_prompt_speech_tokens", "storage", "1", "cuda:0", "emotion_adv", "2", "gen", "prompt_token", "3", "prompt_token_len", "4", "prompt_feat", "5", "embedding", "6");
  const tokens = new BigInt64Array(375).map((_, i) => BigInt(i % 7));
  const files: Record<string, Uint8Array> = {
    "conds/data.pkl": pkl, "conds/byteorder": enc("little"),
    "conds/data/0": new Uint8Array(new Float32Array(256).fill(0.5).buffer), "conds/data/1": new Uint8Array(tokens.buffer),
    "conds/data/2": new Uint8Array(4), "conds/data/3": new Uint8Array(new BigInt64Array(250).fill(9n).buffer), "conds/data/4": new Uint8Array(8),
    "conds/data/5": new Uint8Array(new Float32Array(40_000).fill(-1).buffer), "conds/data/6": new Uint8Array(new Float32Array(192).fill(2).buffer),
    ...over,
  } as Record<string, Uint8Array>;
  return zip(Object.entries(files));
}

describe("conds.pt", () => {
  it("reads a zip's stored entries and refuses a compressed one", () => {
    const z = zipEntries(zip([["a/one", enc("hello")], ["a/two", enc("")]]));
    expect([...z.keys()]).toEqual(["a/one", "a/two"]);
    expect(new TextDecoder().decode(z.get("a/one"))).toBe("hello");
    expect(() => zipEntries(zip([["a", enc("x")]], 8))).toThrow(/compressed/);
    expect(() => zipEntries(enc("not a zip at all, just text that is long enough"))).toThrow(/not a zip/);
  });
  it("finds each tensor's storage from the pickle's strings, without unpickling", () => {
    const keys = pickleStorageKeys(pickle("speaker_emb", "storage", "0", "cuda:0", "cond_prompt_speech_tokens", "1", "prompt_token", "3", "prompt_token_len", "4"), ["speaker_emb", "cond_prompt_speech_tokens", "prompt_token"]);
    expect(Object.fromEntries(keys)).toEqual({ speaker_emb: "0", cond_prompt_speech_tokens: "1", prompt_token: "3" });
    expect(() => pickleStorageKeys(pickle("a", "1"), ["b"])).toThrow(/names no b/);
    // A name followed by another wanted name before any storage key has none of its own.
    expect(() => pickleStorageKeys(pickle("a", "b", "2"), ["a", "b"])).toThrow(/gives a no storage/);
  });
  it("reads the five tensors by byte length from a little-endian file", () => {
    const c = readConds(conds());
    expect(c.condTokens.length).toBe(375);
    expect(c.promptToken[0]).toBe(9n);
    expect(c.promptFeat.length).toBe(40_000);
    expect(c.embedding[191]).toBe(2);
    expect(tensorBytes(CONDS_TENSORS.promptFeat)).toBe(160_000);
    expect(() => readConds(conds({ "conds/data/6": new Uint8Array(764) }))).toThrow(/embedding holds 764 bytes, not 768/);
    expect(() => readConds(conds({ "conds/byteorder": enc("big") }))).toThrow(/little-endian/);
  });
});

/** Protobuf: a varint, then fields. */
const varint = (n: number) => { const out: number[] = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return new Uint8Array(out); };
const field = (f: number, v: number | Uint8Array) => (typeof v === "number" ? cat(varint(f * 8), varint(v)) : cat(varint(f * 8 + 2), varint(v.length), v));
const tensor = (name: string, dataType: number, dims: number[], ext: Record<string, string>) =>
  cat(...dims.map((d) => field(1, d)), field(2, dataType), field(8, enc(name)), ...Object.entries(ext).map(([k, v]) => field(13, cat(field(1, enc(k)), field(2, enc(v))))), field(14, 1));

describe("ONNX graphs", () => {
  const model = field(7, cat(field(1, enc("a node")), field(5, tensor("speech_emb.weight", FLOAT16, [6563, 768], { location: "embed.onnx_data", offset: "77223936", length: "10080768" })),
    field(5, tensor("/Constant_93_output_0", FLOAT16, [1, 1, 768], { location: "enc.onnx_data", offset: "3840", length: "1536" })), field(5, tensor("f32", 1, [2], { location: "enc.onnx_data", offset: "0", length: "8" }))));
  it("lists the initializers with where their bytes are", () => {
    const inits = onnxInitializers(cat(field(1, 8), model));
    expect(inits.map((i) => i.name)).toEqual(["speech_emb.weight", "/Constant_93_output_0", "f32"]);
    expect(inits[0]).toMatchObject({ dataType: FLOAT16, dims: [6563, 768], location: "embed.onnx_data", offset: 77_223_936, length: 10_080_768 });
  });
  it("takes exactly one float16 initializer at an offset and length", () => {
    const inits = onnxInitializers(model);
    expect(initializerAt(inits, "enc.onnx_data", 3840, 1536).name).toBe("/Constant_93_output_0");
    expect(() => initializerAt(inits, "enc.onnx_data", 3840, 1534)).toThrow(/0 initializers/);
    expect(() => initializerAt(inits, "enc.onnx_data", 0, 8)).toThrow(/not float16/);
  });
});

describe("the voice", () => {
  const half = (x: number) => (x === 1 ? 0x3c00 : x === 2 ? 0x4000 : x === -1 ? 0xbc00 : 0);
  it("puts the speaker row first, then each cond token's row of the speech table, as float32", () => {
    const row = new Uint16Array(HIDDEN).fill(half(1));
    const table = new Uint16Array(3 * HIDDEN);
    table.fill(half(-1), HIDDEN, 2 * HIDDEN);
    table.fill(half(2), 2 * HIDDEN);
    const af = audioFeatures(row, table, new BigInt64Array([2n, 1n]));
    expect(af.length).toBe(3 * HIDDEN);
    expect([af[0], af[HIDDEN], af[2 * HIDDEN], af[3 * HIDDEN - 1]]).toEqual([1, 2, -1, -1]);
    expect(() => audioFeatures(row, table, new BigInt64Array([3n]))).toThrow(/outside the 3-row table/);
    expect(() => audioFeatures(row.subarray(1), table, new BigInt64Array([0n]))).toThrow(/767 values/);
  });
  it("writes the four tensors in the voice file's order, with the dims chatterbox.ts feeds", () => {
    const c = readConds(conds());
    const t = voiceTensors(c, new Uint16Array(HIDDEN), new Uint16Array(7 * HIDDEN));
    expect(t.map((x) => x.name)).toEqual([...VOICE_TENSORS]);
    expect(t.map((x) => [x.dtype, x.dims])).toEqual([["float32", [1, 376, 768]], ["int64", [1, 250]], ["float32", [1, 192]], ["float32", [1, 500, 80]]]);
    const back = decodeVoice(encodeVoice(t).slice().buffer);
    expect(back.get("audio_features")!.data.length).toBe(376 * 768);
  });
  it("reads SHA256SUMS and builds pinned resolve URLs", () => {
    const sums = parseSums(`${"a".repeat(64)}  onnx/x.onnx\n${"b".repeat(64)} *config.json\nnot a line\n`);
    expect(Object.fromEntries(sums)).toEqual({ "onnx/x.onnx": "a".repeat(64), "config.json": "b".repeat(64) });
    expect(resolveUrl({ repo: "o/r", revision: "abc", path: "onnx/x" })).toBe("https://huggingface.co/o/r/resolve/abc/onnx/x");
  });
  it("measures the speaker row against spkr_enc(speaker_emb) and the speech rows against the float32 table", () => {
    const c: Pick<CondsTensors, "speakerEmb" | "condTokens"> = { speakerEmb: new Float32Array([1, 2]), condTokens: new BigInt64Array([1n]) };
    const weight = new Float32Array(HIDDEN * 2).fill(0.5), bias = new Float32Array(HIDDEN).fill(1);
    const table = new Float32Array(2 * HIDDEN).fill(3, HIDDEN);
    const af = new Float32Array(2 * HIDDEN);
    af.fill(2.5, 0, HIDDEN);   // 1 + 0.5 * 1 + 0.5 * 2
    af.fill(3, HIDDEN);
    expect(crossCheck(af, c, { bias, weight, table })).toEqual({ speakerRowMaxDiff: 0, speechRowsMaxDiff: 0 });
    af[HIDDEN + 5] = 3.25;
    expect(crossCheck(af, c, { bias, weight, table }).speechRowsMaxDiff).toBeCloseTo(0.25);
  });
});
