// Stopping the cursor assistant's voice, mocked: a clip cancelled while it is being written down is never asked, an
// answer interrupted while Aura-2 is fetching does not mark Aura failed for the rest of the session, an answer
// stopped while the in-browser voice downloads is never spoken once the download finishes, and a long answer is said
// in utterances, with only the unsaid rest left to Aura-2 when the in-browser voice fails part way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dictation = vi.hoisted(() => ({ release: null as ((t: string) => void) | null }));
vi.mock("../src/components/hosted/dictate-button", () => ({
  toDictationWav: async (b: Blob) => b,
  transcribe: () => new Promise<string>((resolve) => { dictation.release = resolve; }),
}));
vi.mock("@/lib/hosted/flags", () => ({ HOSTED: true }));
const api = vi.hoisted(() => ({ calls: 0, impl: null as null | ((init: RequestInit) => Promise<Response>) }));
vi.mock("@/lib/api/client", () => ({ apiFetch: (_p: string, init: RequestInit) => { api.calls++; return api.impl!(init); } }));
const cb = vi.hoisted(() => ({ release: null as (() => void) | null, progress: null as ((p: { loaded: number; total: number }) => void) | null, synthesize: 0, play: 0, texts: [] as string[], failAt: 0 }));
vi.mock("../src/components/assist/chatterbox", () => ({
  voiceFileAvailable: async () => true,
  loadChatterbox: (onProgress: (p: { loaded: number; total: number }) => void) => new Promise((resolve) => { cb.progress = onProgress; cb.release = () => resolve({}); }),
  synthesize: async (_m: unknown, text: string) => { cb.synthesize++; cb.texts.push(text); if (cb.synthesize === cb.failAt) throw new Error("the device was lost"); return new Float32Array(4); },
  playWave: async () => { cb.play++; },
}));

import { listen } from "../src/components/assist/voice-in";
import { primeVoice, speak } from "../src/components/assist/voice-out";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("voice in, record mode (mocked)", () => {
  class Recorder {
    state = "inactive"; mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown) {}
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["x"]) }); this.onstop?.(); }
  }
  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a clip cancelled while it is being written down is dropped, never asked", async () => {
    const h = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onState: vi.fn() };
    const l = listen(h, "record");
    await tick();
    expect(h.onState).toHaveBeenLastCalledWith("listening");
    l.stop();
    await tick();
    expect(h.onState).toHaveBeenLastCalledWith("transcribing");
    l.cancel();
    dictation.release!("give everyone a raise");
    await tick();
    expect(h.onFinal).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("the 15 s cap starts with the clip, not with the permission prompt, however long the person takes to allow it", async () => {
    vi.useFakeTimers();
    try {
      let grant: (s: unknown) => void = () => undefined;
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((r) => { grant = r; }) } });
      const h = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onState: vi.fn() };
      listen(h, "record");
      await vi.advanceTimersByTimeAsync(20_000);
      grant({ getTracks: () => [{ stop() {} }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.onState).toHaveBeenLastCalledWith("listening");
      await vi.advanceTimersByTimeAsync(14_000);
      expect(h.onState).toHaveBeenLastCalledWith("listening");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.onState).toHaveBeenLastCalledWith("transcribing");
    } finally { vi.useRealTimers(); }
  });

  it("a denial that arrives after the person cancelled says nothing, so it never clears a newer session", async () => {
    let deny: (e: unknown) => void = () => undefined;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((_r, j) => { deny = j; }) } });
    const h = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onState: vi.fn() };
    const l = listen(h, "record");
    l.cancel();
    h.onState.mockClear();
    deny(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await tick();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onState).not.toHaveBeenCalled();
  });

  it("stop pressed during the permission prompt records nothing once it is allowed", async () => {
    let grant: (s: unknown) => void = () => undefined;
    const tracks = { stopped: 0 };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise((r) => { grant = r; }) } });
    const h = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onState: vi.fn() };
    const l = listen(h, "record");
    l.stop();
    grant({ getTracks: () => [{ stop() { tracks.stopped++; } }] });
    await tick();
    expect(tracks.stopped).toBe(1);
    expect(h.onState).not.toHaveBeenCalledWith("listening");
    expect(h.onState).toHaveBeenLastCalledWith("idle");
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it("a clip not cancelled is asked once it is written down", async () => {
    const h = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onState: vi.fn() };
    const l = listen(h, "record");
    await tick();
    l.stop();
    await tick();
    dictation.release!("where is the audit log");
    await tick();
    expect(h.onFinal).toHaveBeenCalledWith("where is the audit log");
  });
});

describe("voice out, stopped (mocked)", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete (WebAssembly as { Suspending?: unknown }).Suspending; });

  it("an answer interrupted while Aura-2 is fetching leaves Aura in the chain for the next answer", async () => {
    vi.stubGlobal("navigator", {});
    // Playback was unlocked by the person's gesture (voice-out.ts primeVoice); without it the route is never asked.
    vi.stubGlobal("Audio", class { src = ""; onended: (() => void) | null = null; onerror: (() => void) | null = null; play() { return Promise.resolve(); } pause() {} });
    primeVoice();
    await tick();
    api.calls = 0;
    api.impl = (init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    const c = new AbortController();
    const first = speak("Four paychecks need review.", { signal: c.signal });
    await tick();
    c.abort();
    expect(await first).toBeNull();
    expect(api.calls).toBe(1);
    // The next answer still goes to Aura (a real failure would have dropped it from the chain).
    const c2 = new AbortController();
    const second = speak("The audit log is here.", { signal: c2.signal });
    await tick();
    expect(api.calls).toBe(2);
    c2.abort();
    await second;
  });

  it("an answer stopped while the in-browser voice downloads is never spoken, and its progress stops", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
    (WebAssembly as { Suspending?: unknown }).Suspending = function Suspending() {};
    const onProgress = vi.fn();
    const c = new AbortController();
    const done = speak("Four paychecks need review.", { signal: c.signal, onProgress });
    for (let i = 0; i < 5 && !cb.progress; i++) await tick();
    cb.progress!({ loaded: 1, total: 10 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    c.abort();
    cb.progress!({ loaded: 5, total: 10 });
    cb.release!();
    expect(await done).toBeNull();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(cb.synthesize).toBe(0);
    expect(cb.play).toBe(0);
  });

  it("says a long answer in utterances, and leaves Aura-2 only the rest when the in-browser voice fails part way", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
    (WebAssembly as { Suspending?: unknown }).Suspending = function Suspending() {};
    const answer = "Requests are on the Time Off page. A new hire asks from the portal; each request runs its checks before it reaches the manager.";
    cb.texts = []; cb.synthesize = 0; cb.play = 0; cb.failAt = 0; cb.release = null;
    const done = speak(answer);
    for (let i = 0; i < 5 && !cb.release; i++) await tick();
    cb.release!();
    expect(await done).toBe("chatterbox");
    expect(cb.texts).toEqual(["Requests are on the Time Off page.", "A new hire asks from the portal; each request runs its checks before it reaches the manager."]);
    expect(cb.play).toBe(2);

    // The second utterance fails: the first was said, so Aura-2 is asked for the second only.
    cb.texts = []; cb.synthesize = 0; cb.play = 0; cb.failAt = 2; cb.release = null;
    let body = "";
    api.impl = (init) => { body = String(init.body); return new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))); };
    const c = new AbortController();
    const second = speak(answer, { signal: c.signal });
    for (let i = 0; i < 5 && !cb.release; i++) await tick();
    cb.release!();
    for (let i = 0; i < 10 && !body; i++) await tick();
    expect(cb.play).toBe(1);
    expect(JSON.parse(body)).toEqual({ text: "A new hire asks from the portal; each request runs its checks before it reaches the manager." });
    c.abort();
    expect(await second).toBeNull();
  });
});
