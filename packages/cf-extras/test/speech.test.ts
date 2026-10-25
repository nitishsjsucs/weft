// Spoken answers (src/speech.ts): the text is checked before any model call, the reservation is the text's exact cost
// against the speech share, a failed call settles at that cost and answers SPEECH_FAILED, and the audio is returned
// whatever shape the binding gives it.
import { describe, expect, it } from "vitest";
import { SPEECH_MAX_CHARS, SPEECH_MODEL, SPEECH_SPEAKER, speechNeurons } from "../../contracts/src/ext/assist-speech";
import { NEURON_SHARES } from "../../contracts/src/ext/cf-agent";
import { memoryNeuronBudget } from "../src/neurons";
import { createSpeech, SPEECH_MAX_AUDIO_BYTES, speechText } from "../src/speech";
import { fakeAi } from "./fakes";

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]);

describe("spoken answers", () => {
  it("speaks a short answer with the fixed voice, charged its exact cost to the speech share", async () => {
    const ai = fakeAi({ [SPEECH_MODEL]: () => MP3 });
    const neurons = memoryNeuronBudget();
    const r = await createSpeech({ ai, neurons, enabled: () => true, gateway: { id: "weft" }, charge: { visitor: "v_1" } }).speak({ text: "  Four paychecks\n need review.  " });
    expect(r).toEqual({ ok: true, audio: MP3, contentType: "audio/mpeg", chars: 27, neurons: speechNeurons(27) });
    expect(ai.calls).toEqual([{ model: SPEECH_MODEL, inputs: { text: "Four paychecks need review.", speaker: SPEECH_SPEAKER, encoding: "mp3" }, options: { gateway: { id: "weft" } } }]);
    expect(neurons.used("speech")).toBe(speechNeurons(27));
    expect(neurons.open()).toBe(0);
    // 180 characters, the most it speaks, is about 491 neurons.
    expect(speechNeurons(SPEECH_MAX_CHARS)).toBe(492);
  });

  it("refuses empty, too long and switched-off text before any model call", async () => {
    const ai = fakeAi({ [SPEECH_MODEL]: () => MP3 });
    const neurons = memoryNeuronBudget();
    const s = createSpeech({ ai, neurons, enabled: () => true });
    expect(await s.speak({ text: " \n " })).toMatchObject({ ok: false, code: "SPEECH_EMPTY" });
    expect(await s.speak({ text: "x".repeat(SPEECH_MAX_CHARS + 1) })).toMatchObject({ ok: false, code: "SPEECH_TOO_LONG" });
    expect(await s.speak({ text: 42 as never })).toMatchObject({ ok: false, code: "SPEECH_EMPTY" });
    expect(await createSpeech({ ai, neurons, enabled: () => false }).speak({ text: "Hello." })).toMatchObject({ ok: false, code: "SPEECH_DISABLED" });
    expect(ai.calls).toHaveLength(0);
    expect(neurons.used("speech") + neurons.open()).toBe(0);
    expect(speechText("a\u0000b\tc")).toBe("ab c");
  });

  it("stops at the speech share for the day", async () => {
    const ai = fakeAi({ [SPEECH_MODEL]: () => MP3 });
    const neurons = memoryNeuronBudget({ ...NEURON_SHARES, speech: speechNeurons(SPEECH_MAX_CHARS) + 10 });
    const s = createSpeech({ ai, neurons, enabled: () => true });
    expect((await s.speak({ text: "y".repeat(SPEECH_MAX_CHARS) })).ok).toBe(true);
    expect(await s.speak({ text: "y".repeat(SPEECH_MAX_CHARS) })).toMatchObject({ ok: false, code: "SPEECH_BUDGET" });
    expect(ai.calls).toHaveLength(1);
  });

  it("settles a failed or empty call at its cost and answers SPEECH_FAILED", async () => {
    for (const handler of [() => { throw new Error("upstream 500"); }, () => ({ nothing: true }), () => new Uint8Array(0), () => new Uint8Array(SPEECH_MAX_AUDIO_BYTES + 1)]) {
      const neurons = memoryNeuronBudget();
      const r = await createSpeech({ ai: fakeAi({ [SPEECH_MODEL]: handler }), neurons, enabled: () => true }).speak({ text: "Hello there." });
      expect(r).toMatchObject({ ok: false, code: "SPEECH_FAILED" });
      expect(neurons.used("speech")).toBe(speechNeurons(12));
      expect(neurons.open()).toBe(0);
    }
  });

  it("reads the audio from a stream, a Response or base64 as well as raw bytes", async () => {
    const shapes: (() => unknown)[] = [
      () => new Response(MP3).body, () => new Response(MP3), () => ({ audio: btoa(String.fromCharCode(...MP3)) }), () => MP3.buffer.slice(0),
    ];
    for (const shape of shapes) {
      const r = await createSpeech({ ai: fakeAi({ [SPEECH_MODEL]: shape }), neurons: memoryNeuronBudget(), enabled: () => true }).speak({ text: "Hi." });
      expect(r.ok && [...r.audio]).toEqual([...MP3]);
    }
  });
});
