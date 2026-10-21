// Dictation (design 5.4): clips of at most 30 s, whisper-large-v3-turbo through the gateway, 300 neurons a day, the
// kill flag; the text only fills the composer (the result is text, never a send).
import { describe, expect, it } from "vitest";
import { DICTATION_MODEL } from "../../contracts/src/ext/cf-extras";
import { createDictation, DICTATION_MAX_BYTES, wavSeconds } from "../src/dictation";
import { DICTATION_RESERVE_NEURONS, dictationNeurons, memoryNeuronBudget } from "../src/neurons";
import { fakeAi } from "./fakes";

/** A 16 kHz mono 16-bit PCM WAV of `seconds` of silence. */
function wav(seconds: number): Uint8Array {
  const rate = 16_000, byteRate = rate * 2, data = Math.round(seconds * byteRate);
  const b = new Uint8Array(44 + data);
  const dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, byteRate, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, "data"); dv.setUint32(40, data, true);
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
  });

  it("refuses long, oversized or non-audio clips before any model call", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("x") });
    const d = createDictation({ ai, neurons: memoryNeuronBudget(), enabled: () => true });
    expect(await d.transcribe({ audio: wav(31), contentType: "audio/wav" })).toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    const big = new Uint8Array(DICTATION_MAX_BYTES + 1); big.set(webm);
    expect(await d.transcribe({ audio: big, contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    expect(await d.transcribe({ audio: new TextEncoder().encode("hello"), contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    expect(await d.transcribe({ audio: new Uint8Array(), contentType: "audio/webm" })).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    expect(await createDictation({ ai, neurons: memoryNeuronBudget(), enabled: async () => false }).transcribe({ audio: wav(1), contentType: "audio/wav" })).toMatchObject({ ok: false, code: "DICTATION_DISABLED" });
    expect(ai.calls).toHaveLength(0);
  });

  it("respects its 300-neuron daily share: twelve 30 s clips, then DICTATION_BUDGET", async () => {
    const ai = fakeAi({ [DICTATION_MODEL]: whisper("a thirty second clip", 30) });
    const neurons = memoryNeuronBudget();
    const d = createDictation({ ai, neurons, enabled: () => true });
    expect(DICTATION_RESERVE_NEURONS).toBe(dictationNeurons(30));
    expect(dictationNeurons(30)).toBe(24);
    const results = [];
    for (let i = 0; i < 13; i++) results.push(await d.transcribe({ audio: webm, contentType: "audio/webm" }));
    expect(results.filter((r) => r.ok)).toHaveLength(12);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "DICTATION_BUDGET" });
    expect(ai.calls).toHaveLength(12);
    expect(neurons.used("dictation")).toBe(288);
  });

  it("a clip the model reports as too long, or with no speech, returns no text; a failed call settles at the reserve", async () => {
    const neurons = memoryNeuronBudget();
    expect(await createDictation({ ai: fakeAi({ [DICTATION_MODEL]: whisper("long", 45) }), neurons, enabled: () => true }).transcribe({ audio: webm, contentType: "audio/webm" }))
      .toMatchObject({ ok: false, code: "DICTATION_TOO_LONG" });
    expect(await createDictation({ ai: fakeAi({ [DICTATION_MODEL]: whisper("   ", 2) }), neurons, enabled: () => true }).transcribe({ audio: webm, contentType: "audio/webm" }))
      .toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    const failing = createDictation({ ai: fakeAi({ [DICTATION_MODEL]: () => { throw new Error("upstream 502"); } }), neurons, enabled: () => true });
    await expect(failing.transcribe({ audio: webm, contentType: "audio/webm" })).rejects.toThrow(/502/);
    expect(neurons.open()).toBe(0);
    expect(neurons.used("dictation")).toBe(24 + 2 + 24);
  });
});
