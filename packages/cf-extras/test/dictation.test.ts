// Dictation (design 5.4): clips of at most 30 s, whisper-large-v3-turbo through the gateway, 300 neurons a day, the
// kill flag; the text only fills the composer (the result is text, never a send). A clip's length is known before
// the call (PCM WAV only, its length from its byte count), so nothing is transcribed and then refused, and the
// ledger records the longer of that length and the one the model reports.
import { describe, expect, it } from "vitest";
import { DICTATION_MODEL } from "../../contracts/src/ext/cf-extras";
import { createDictation, DICTATION_MAX_BYTES, wavSeconds } from "../src/dictation";
import { DICTATION_RESERVE_NEURONS, dictationNeurons, memoryNeuronBudget } from "../src/neurons";
import { DICTATION_SAMPLE_RATE, encodePcm16Wav, pcmWavInfo } from "../src/wav";
import { fakeAi } from "./fakes";

/** A 16 kHz mono 16-bit PCM WAV of `seconds` of silence. */
const wav = (seconds: number) => encodePcm16Wav(new Float32Array(Math.round(seconds * DICTATION_SAMPLE_RATE)));
/** A WAV with a hand-written fmt chunk (tag, channels, rate, byte rate, block align, bits) and `data` bytes of audio. */
function wavWith(fmt: { tag?: number; channels?: number; rate?: number; byteRate?: number; align?: number; bits?: number }, data: number, declared = data): Uint8Array {
  const f = { tag: 1, channels: 1, rate: 16_000, bits: 16, ...fmt };
  const align = f.align ?? (f.channels * f.bits) / 8, byteRate = f.byteRate ?? f.rate * align;
  const b = new Uint8Array(44 + data);
  const dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, f.tag, true); dv.setUint16(22, f.channels, true);
  dv.setUint32(24, f.rate, true); dv.setUint32(28, byteRate, true); dv.setUint16(32, align, true); dv.setUint16(34, f.bits, true); put(36, "data"); dv.setUint32(40, declared, true);
  return b;
}
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const whisper = (text: string, duration?: number) => () => ({ text, word_count: text.split(" ").length, ...(duration !== undefined ? { transcription_info: { language: "en", duration } } : {}) });

describe("Dictation", () => {
  it("transcribes a short clip through the gateway and settles the neurons it used", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("  Show payroll cost   by month ", 3) });
    const neurons = memoryNeuronBudget();
    const gateway = { id: "gw", metadata: { slot: "slot-1", gen: 1, run: null, kind: "dictation", visitor: "v_1" } };
    const r = await createDictation({ ai, neurons, enabled: () => true, gateway }).transcribe({ audio: wav(3), contentType: "audio/wav" });
    expect(r).toEqual({ ok: true, text: "Show payroll cost by month", seconds: 3, neurons: 3 });
    expect(ai.calls[0]).toMatchObject({ model: DICTATION_MODEL, options: { gateway } });
    expect(typeof ai.calls[0]!.inputs.audio).toBe("string");
    expect(neurons.used("dictation")).toBe(3);
    expect(neurons.open()).toBe(0);
    expect(wavSeconds(wav(3))).toBe(3);
    expect(wavSeconds(webm)).toBeNull();
    expect(wav(30).length).toBe(960_044);
    expect(wav(30).length).toBeLessThan(DICTATION_MAX_BYTES);
  });

  it("refuses long, oversized, compressed or non-audio clips before any model call", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("x") });
    const neurons = memoryNeuronBudget();
    const d = createDictation({ ai, neurons, enabled: () => true });
    expect(await d.transcribe({ audio: wav(31), contentType: "audio/wav" })).toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    const big = new Uint8Array(DICTATION_MAX_BYTES + 1); big.set(webm);
    expect(await d.transcribe({ audio: big, contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    // A compressed clip's length is a container field its sender writes: one megabyte of Opus is minutes of audio.
    const opus = new Uint8Array(DICTATION_MAX_BYTES); opus.set(webm);
    expect(await d.transcribe({ audio: opus, contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE", message: expect.stringContaining("PCM WAV") });
    for (const magic of ["OggS", "ID3", "\0\0\0\x18ftypM4A "]) {
      expect(await d.transcribe({ audio: new TextEncoder().encode(`${magic}....`), contentType: "audio/ogg" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    }
    expect(await d.transcribe({ audio: new TextEncoder().encode("hello"), contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    expect(await d.transcribe({ audio: new Uint8Array(), contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    expect(await createDictation({ ai, neurons, enabled: async () => false }).transcribe({ audio: wav(1), contentType: "audio/wav" })).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
    expect(ai.calls).toHaveLength(0);
    expect(neurons.used("dictation") + neurons.open()).toBe(0);
  });

  it("measures a WAV by its bytes and its format, never by the header's own length fields", () => {
    // 8 kHz 8-bit mono: one megabyte is 125 s, however small the data chunk claims to be.
    expect(pcmWavInfo(wavWith({ rate: 8_000, bits: 8 }, 1_000_000 - 44, 8_000))!.seconds).toBeCloseTo(125, 0);
    expect(pcmWavInfo(wavWith({}, 32_000 * 2))).toMatchObject({ format: "pcm", sampleRate: 16_000, channels: 1, bitsPerSample: 16, seconds: 2 });
    expect(pcmWavInfo(wavWith({ tag: 3, bits: 32 }, 64_000 * 2))).toMatchObject({ format: "float", seconds: 2 });
    // A byte rate that understates the format, a compressed codec inside RIFF, or a fmt chunk that does not add up.
    expect(pcmWavInfo(wavWith({ rate: 8_000, bits: 8, byteRate: 1_000_000 }, 80_000))).toBeNull();
    expect(pcmWavInfo(wavWith({ tag: 0x11, bits: 4, align: 256, byteRate: 4_055 }, 40_000))).toBeNull();
    expect(pcmWavInfo(wavWith({ tag: 0x55 }, 1_000))).toBeNull();
    expect(pcmWavInfo(wavWith({ channels: 6 }, 1_000))).toBeNull();
    expect(pcmWavInfo(wavWith({ rate: 4_000 }, 1_000))).toBeNull();
    expect(pcmWavInfo(webm)).toBeNull();
  });

  it("a slow-rate WAV over 30 s is refused before the call, though its data chunk claims one second", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("long", 1) });
    const r = await createDictation({ ai, neurons: memoryNeuronBudget(), enabled: () => true }).transcribe({ audio: wavWith({ rate: 8_000, bits: 8 }, 400_000, 8_000), contentType: "audio/wav" });
    expect(r).toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    expect(ai.calls).toHaveLength(0);
  });

  it("respects its 300-neuron daily share: twelve 30 s clips, then DICTATION_BUDGET", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("a thirty second clip", 30) });
    const neurons = memoryNeuronBudget();
    const d = createDictation({ ai, neurons, enabled: () => true });
    expect(DICTATION_RESERVE_NEURONS).toBe(24);
    expect(dictationNeurons(30)).toBe(24);
    const clip = wav(30);
    const results = [];
    for (let i = 0; i < 13; i++) results.push(await d.transcribe({ audio: clip, contentType: "audio/wav" }));
    expect(results.filter((r) => r.ok)).toHaveLength(12);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "DICTATION_BUDGET" });
    expect(ai.calls).toHaveLength(12);
    expect(neurons.used("dictation")).toBe(288);
  });

  it("settles the longer of the clip's length and the model's; no speech returns no text; a failed call settles at the reserve", async () => {
    const neurons = memoryNeuronBudget();
    // The model reports a longer clip than its bytes hold (it should not): the ledger takes the model's 45 s, 35 neurons.
    expect(await createDictation({ ai: fakeAi({ [DICTATION_MODEL]: whisper("long", 45) }), neurons, enabled: () => true }).transcribe({ audio: wav(20), contentType: "audio/wav" }))
      .toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    expect(neurons.used("dictation")).toBe(dictationNeurons(45));
    // It reports a shorter one (voice activity trimmed): the ledger keeps the clip's own 20 s.
    expect(await createDictation({ ai: fakeAi({ [DICTATION_MODEL]: whisper("short", 4) }), neurons, enabled: () => true }).transcribe({ audio: wav(20), contentType: "audio/wav" }))
      .toMatchObject({ ok: true, seconds: 4, neurons: dictationNeurons(20) });
    expect(await createDictation({ ai: fakeAi({ [DICTATION_MODEL]: whisper("   ", 2) }), neurons, enabled: () => true }).transcribe({ audio: wav(2), contentType: "audio/wav" }))
      .toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    const failing = createDictation({ ai: fakeAi({ [DICTATION_MODEL]: () => { throw new Error("upstream 502"); } }), neurons, enabled: () => true });
    await expect(failing.transcribe({ audio: wav(30), contentType: "audio/wav" })).rejects.toThrow(/502/);
    expect(neurons.open()).toBe(0);
    expect(neurons.used("dictation")).toBe(35 + 16 + 2 + 24);
  });
});
