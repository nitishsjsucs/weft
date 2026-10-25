// The fixed voice this server ships (public/assist/voice/weft-voice.bin; scripts/assist/build-voice.ts): it decodes,
// it holds the four tensors chatterbox.ts feeds the graphs with the dims and types they take, and its provenance file
// names the same bytes, Resemble AI's built-in default voice and the pinned sources it was made from.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeVoice, VOICE_TENSORS } from "../src/components/assist/chatterbox-core";

const file = readFileSync(new URL("../public/assist/voice/weft-voice.bin", import.meta.url));
const provenance = JSON.parse(readFileSync(new URL("../public/assist/voice/weft-voice.provenance.json", import.meta.url), "utf8")) as {
  voice: string; file: { bytes: number; sha256: string }; sources: { repo: string; revision: string; path: string; sha256: string }[];
};

describe("the shipped voice file", () => {
  it("decodes to the four tensors with the dims and types the graphs take", () => {
    const v = decodeVoice(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    expect([...v.keys()]).toEqual([...VOICE_TENSORS]);
    expect(VOICE_TENSORS.map((n) => [n, v.get(n)!.dtype, v.get(n)!.dims])).toEqual([
      ["audio_features", "float32", [1, 376, 768]],
      ["audio_tokens", "int64", [1, 250]],
      ["speaker_embeddings", "float32", [1, 192]],
      ["speaker_features", "float32", [1, 500, 80]],
    ]);
    expect(v.get("audio_features")!.data).toBeInstanceOf(Float32Array);
    expect(v.get("audio_tokens")!.data).toBeInstanceOf(BigInt64Array);
    // Speech tokens below the start token (6561), and finite features.
    expect([...(v.get("audio_tokens")!.data as BigInt64Array)].every((t) => t >= 0n && t < 6561n)).toBe(true);
    expect((v.get("audio_features")!.data as Float32Array).every(Number.isFinite)).toBe(true);
  });
  it("is the file its provenance names, from Resemble AI's built-in default voice at pinned revisions", () => {
    expect(file.length).toBe(provenance.file.bytes);
    expect(createHash("sha256").update(file).digest("hex")).toBe(provenance.file.sha256);
    expect(provenance.voice).toBe("Resemble AI built-in default voice, MIT; speaker not documented");
    expect(provenance.sources.map((s) => `${s.repo}@${s.revision}/${s.path}`)).toEqual([
      "ResembleAI/chatterbox-nano@71ccd1d0081b430592cea481f4307e764e07bc64/conds.pt",
      "owensong/chatterbox-nano-ONNX@4a66d7dab72a9e98f24b515d49a1d7a81632df2e/onnx/speech_encoder_q4f16.onnx_data",
      "owensong/chatterbox-nano-ONNX@4a66d7dab72a9e98f24b515d49a1d7a81632df2e/onnx/embed_tokens_fp16.onnx_data",
    ]);
  });
});
