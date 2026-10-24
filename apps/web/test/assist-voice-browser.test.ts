// Spoken answers through the browser's own speech, mocked (the local app ships no voice file, so it is the only
// engine there): the first answer waits for a voice list that has not loaded yet instead of saying spoken answers are
// unavailable, and one failed utterance stays that answer's, so the next answer speaks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hosted/flags", () => ({ HOSTED: false }));
vi.mock("@/lib/api/client", () => ({ apiFetch: () => { throw new Error("no hosted speak route on the local app"); } }));

import { primeVoice, speak } from "../src/components/assist/voice-out";

const VOICE = { localService: true, lang: "en-US", default: true, name: "Local" };

/** A fake speechSynthesis: voices arrive after `loadAfter` reads, and each utterance ends or errors as `outcomes` say. */
function fakeSpeech(o: { voicesLater?: boolean; outcomes?: ("end" | "audio-busy")[] }) {
  let voices: (typeof VOICE)[] = o.voicesLater ? [] : [VOICE];
  const listeners = new Set<() => void>();
  const spoken: string[] = [];
  const outcomes = [...(o.outcomes ?? [])];
  const synth = {
    getVoices: () => voices,
    addEventListener: (_t: string, f: () => void) => listeners.add(f),
    removeEventListener: (_t: string, f: () => void) => listeners.delete(f),
    cancel: () => undefined,
    speak: (u: { text: string; onend?: () => void; onerror?: (e: { error: string }) => void }) => {
      spoken.push(u.text);
      if (!u.text) return;
      const out = outcomes.shift() ?? "end";
      setTimeout(() => (out === "end" ? u.onend?.() : u.onerror?.({ error: out })), 0);
    },
  };
  class Utterance { voice: unknown = null; volume = 1; onend?: () => void; onerror?: (e: { error: string }) => void; constructor(public text: string) {} }
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  return { spoken, arrive: () => { voices = [VOICE]; for (const f of [...listeners]) f(); } };
}

describe("spoken answers through the browser's speech (mocked)", () => {
  beforeEach(() => vi.stubGlobal("navigator", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("the first answer waits for the voice list Chrome loads after its first read, then speaks", async () => {
    const s = fakeSpeech({ voicesLater: true });
    const said = speak("Four paychecks need review.");
    setTimeout(s.arrive, 20);
    expect(await said).toBe("browser");
    expect(s.spoken).toContain("Four paychecks need review.");
  });

  it("one failed utterance is that answer's alone: the next answer speaks", async () => {
    const s = fakeSpeech({ outcomes: ["audio-busy", "end"] });
    expect(await speak("First answer.")).toBeNull();
    expect(await speak("Second answer.")).toBe("browser");
    expect(s.spoken).toEqual(["First answer.", "Second answer."]);
  });

  it("primes speech inside the gesture: the voice list starts loading and an empty utterance is spoken once", () => {
    const s = fakeSpeech({});
    primeVoice();
    primeVoice();
    expect(s.spoken).toEqual([""]);
  });
});
