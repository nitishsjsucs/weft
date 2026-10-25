// The cursor assistant's voice paths, mocked: which voice in a browser gets (live recognition, then the hosted WAV
// route, then none), the spoken answer's engines in order with failures moving down the chain, the local voice pick
// that never sends text away, the spoken text, live recognition's transcript and errors, and the pure parts of the
// in-browser voice (the voice file, half floats, sampling, the decoder's tokens).
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickLocalVoice, spokenText, voiceInMode, voiceOutChain, type VoiceOutEnv } from "../src/components/assist/voice-core";
import { fallbackMode, listen, VOICE_COPY } from "../src/components/assist/voice-in";
import { applyRepetitionPenalty, concatSeq, decodeVoice, encodeVoice, halfToFloat, sampleToken, SILENCE, speechTokens, START_SPEECH, STOP_SPEECH, utterances, UTTERANCE_MAX_CHARS, type VoiceTensor } from "../src/components/assist/chatterbox-core";

describe("voice in", () => {
  it("prefers live recognition, then the hosted dictation route, then none", () => {
    expect(voiceInMode({ speechRecognition: true, mediaRecorder: false, getUserMedia: false, hosted: false })).toBe("live");
    expect(voiceInMode({ speechRecognition: false, mediaRecorder: true, getUserMedia: true, hosted: true })).toBe("record");
    expect(voiceInMode({ speechRecognition: false, mediaRecorder: true, getUserMedia: true, hosted: false })).toBe("none");
    expect(voiceInMode({ speechRecognition: false, mediaRecorder: false, getUserMedia: true, hosted: true })).toBe("none");
  });
  it("falls back to recording only on the hosted app, only when the speech service is the problem", () => {
    expect(fallbackMode("network", true, true)).toBe("record");
    expect(fallbackMode("service-not-allowed", true, true)).toBe("record");
    expect(fallbackMode("network", false, true)).toBeNull();
    expect(fallbackMode("not-allowed", true, true)).toBeNull();
    expect(fallbackMode("network", true, false)).toBeNull();
  });
});

type Handler = { onresult: ((e: unknown) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };
function fakeRecognition(script: (r: Handler) => void) {
  return class {
    lang = ""; interimResults = false; continuous = false; maxAlternatives = 1;
    onresult: Handler["onresult"] = null; onerror: Handler["onerror"] = null; onend: Handler["onend"] = null;
    start() { queueMicrotask(() => script(this)); }
    stop() { this.onend?.(); }
    abort() { /* nothing */ }
  };
}
const result = (parts: [string, boolean][]) => ({ resultIndex: 0, results: parts.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });

describe("listen (live recognition, mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows the partial transcript and hands over the final one", async () => {
    vi.stubGlobal("window", { SpeechRecognition: fakeRecognition((r) => { r.onresult?.(result([["How do I ", false]])); r.onresult?.(result([["How do I approve time off", true]])); r.onend?.(); }) });
    const partial: string[] = [];
    const final = await new Promise<string>((resolve, reject) => listen({ onPartial: (t) => partial.push(t), onFinal: resolve, onError: reject }, "live"));
    expect(partial).toEqual(["How do I", "How do I approve time off"]);
    expect(final).toBe("How do I approve time off");
  });
  it("says plainly when the microphone is not allowed, or nothing was heard", async () => {
    vi.stubGlobal("window", { SpeechRecognition: fakeRecognition((r) => r.onerror?.({ error: "not-allowed" })) });
    expect(await new Promise((resolve) => listen({ onPartial: () => undefined, onFinal: () => undefined, onError: resolve }, "live"))).toBe(VOICE_COPY.denied);
    vi.stubGlobal("window", { SpeechRecognition: fakeRecognition((r) => r.onend?.()) });
    expect(await new Promise((resolve) => listen({ onPartial: () => undefined, onFinal: () => undefined, onError: resolve }, "live"))).toBe(VOICE_COPY.noSpeech);
  });
  it("says voice is unavailable when the browser has none", async () => {
    expect(await new Promise((resolve) => listen({ onPartial: () => undefined, onFinal: () => undefined, onError: resolve }, "none"))).toBe(VOICE_COPY.none);
  });
});

describe("voice out", () => {
  const env = (over: Partial<VoiceOutEnv>): VoiceOutEnv => ({ webgpu: true, shaderF16: true, jspi: true, voiceFile: true, hosted: true, localVoice: true, failed: new Set(), ...over });
  it("tries the in-browser voice, then Aura-2 on the hosted app, then the device's own voice", () => {
    expect(voiceOutChain(env({}))).toEqual(["chatterbox", "aura", "browser"]);
    expect(voiceOutChain(env({ webgpu: false }))).toEqual(["aura", "browser"]);
    // The language model's key and value cache is float16: an adapter without shader-f16 cannot run it.
    expect(voiceOutChain(env({ shaderF16: false }))).toEqual(["aura", "browser"]);
    expect(voiceOutChain(env({ voiceFile: false }))).toEqual(["aura", "browser"]);
    expect(voiceOutChain(env({ hosted: false, webgpu: false }))).toEqual(["browser"]);
    expect(voiceOutChain(env({ failed: new Set(["chatterbox"]) }))).toEqual(["aura", "browser"]);
    expect(voiceOutChain(env({ failed: new Set(["chatterbox", "aura"]) }))).toEqual(["browser"]);
    expect(voiceOutChain(env({ webgpu: false, hosted: false, localVoice: false }))).toEqual([]);
  });
  it("picks a voice the device provides, never a network one", () => {
    const v = (lang: string, localService: boolean, d = false) => ({ lang, localService, default: d, name: `${lang}${localService}` });
    expect(pickLocalVoice([v("en-US", false, true), v("fr-FR", true), v("en-GB", true)])?.lang).toBe("en-GB");
    expect(pickLocalVoice([v("en-US", true), v("en-GB", true, true)])?.lang).toBe("en-GB");
    expect(pickLocalVoice([v("en-US", false), v("en-GB", false)])).toBeNull();
  });
  it("speaks the answer's words without citations or ids, cut at a sentence", () => {
    expect(spokenText("Four paychecks need review [res_0001]. Open wrk_0026 first.", 200)).toBe("Four paychecks need review . Open first.");
    expect(spokenText("This is the first sentence. And then a second one follows here.", 40)).toBe("This is the first sentence.");
  });
});

describe("the in-browser voice, pure parts", () => {
  it("round-trips the fixed voice file", () => {
    const tensors: VoiceTensor[] = [
      { name: "audio_features", dtype: "float16", dims: [1, 2, 2], data: new Uint16Array([0x3c00, 0, 0x4000, 0xbc00]) },
      { name: "audio_tokens", dtype: "int64", dims: [1, 3], data: new BigInt64Array([1n, 2n, 3n]) },
      { name: "speaker_embeddings", dtype: "float32", dims: [1, 2], data: new Float32Array([0.5, -0.5]) },
      { name: "speaker_features", dtype: "float32", dims: [1, 1, 2], data: new Float32Array([1, 2]) },
    ];
    const back = decodeVoice(encodeVoice(tensors).slice().buffer);
    expect([...(back.get("audio_tokens")!.data as BigInt64Array)]).toEqual([1n, 2n, 3n]);
    expect([...(back.get("speaker_embeddings")!.data as Float32Array)]).toEqual([0.5, -0.5]);
    expect(() => decodeVoice(new Uint8Array([1, 2, 3, 4]).buffer)).toThrow(/not a Weft voice file/);
  });
  it("reads half floats and joins sequences", () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(concatSeq(new Float32Array([1, 2]), [1, 1, 2], new Float32Array([3, 4]), [1, 1, 2])).toEqual({ data: new Float32Array([1, 2, 3, 4]), dims: [1, 2, 2] });
  });
  it("says a long answer in utterances of whole sentences, each within the cap, losing no words", () => {
    const answer = "Requests are on the Time Off page. A new hire asks from the portal; each request runs its checks before it reaches the manager.";
    expect(utterances(answer)).toEqual(["Requests are on the Time Off page.", "A new hire asks from the portal; each request runs its checks before it reaches the manager."]);
    expect(utterances("Pay is up 12.5% this period. That is all.")).toEqual(["Pay is up 12.5% this period. That is all."]);
    const long = "The largest change is on one paycheck, which is up because of a retro raise, an overtime correction, a bonus approved late, and a move to another state with its own withholding.";
    const parts = utterances(long);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= UTTERANCE_MAX_CHARS)).toBe(true);
    expect(parts[0]).toMatch(/,$/);
    expect(parts.join(" ")).toBe(long);
    const words = "word ".repeat(100).trim();
    expect(utterances(words).every((p) => p.length <= UTTERANCE_MAX_CHARS && !p.startsWith(" "))).toBe(true);
    expect(utterances(words).join(" ")).toBe(words);
    expect(utterances("  ")).toEqual([]);
  });
  it("penalizes repeats, samples within top-p, and builds the decoder's tokens", () => {
    const logits = new Float32Array([2, -2, 1]);
    applyRepetitionPenalty(logits, [0, 1], 2);
    expect([...logits]).toEqual([1, -4, 1]);
    expect(sampleToken(new Float32Array([10, 0, 0]), { temperature: 1, topK: 3, topP: 0.5 }, () => 0.99)).toBe(0);
    expect([...speechTokens([7, 8], [START_SPEECH, 5, 6, STOP_SPEECH])]).toEqual([7n, 8n, 5n, 6n, BigInt(SILENCE), BigInt(SILENCE), BigInt(SILENCE)]);
  });
});
