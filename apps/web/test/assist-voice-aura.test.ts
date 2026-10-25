// Spoken answers through Aura-2 on the hosted app, mocked (components/assist/voice-out.ts): the speak route is asked
// only once playback was unlocked inside the person's gesture, so no neurons go to audio a browser such as Safari
// would refuse to play; and a passing refusal (a rate limit, a check, a pause, one failed call) only falls back for
// that answer, while one that lasts takes Aura out for the session, or until 00:00 UTC for the day's spent share.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auraRefusalSpan, nextUtcMidnight } from "../src/components/assist/voice-core";

vi.mock("@/lib/hosted/flags", () => ({ HOSTED: true }));
const api = vi.hoisted(() => ({ calls: 0, reply: null as null | (() => Response) }));
vi.mock("@/lib/api/client", () => ({ apiFetch: async () => { api.calls++; return api.reply!(); } }));
vi.mock("../src/components/assist/chatterbox", () => ({ voiceFileAvailable: async () => false }));

const tick = () => new Promise((r) => setTimeout(r, 0));
const refusal = (status: number, code: string) => () => new Response(JSON.stringify({ code, message: code }), { status, headers: { "content-type": "application/json" } });
const audio = () => new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } });
/** An audio element whose play() resolves (or is refused, as Safari refuses one outside a gesture) and that ends at once. */
function stubAudio(allowed: () => boolean) {
  vi.stubGlobal("Audio", class {
    src = ""; onended: (() => void) | null = null; onerror: (() => void) | null = null;
    play() {
      if (!allowed()) return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }));
      if (!this.src.startsWith("blob:") || this.src === "") return Promise.resolve();
      setTimeout(() => this.onended?.(), 0);
      return Promise.resolve();
    }
    pause() {}
  });
}
/** A fresh module (its session state: what failed, whether playback is unlocked). */
async function voiceOut() { vi.resetModules(); return import("../src/components/assist/voice-out"); }

beforeEach(() => { api.calls = 0; vi.stubGlobal("navigator", {}); });
afterEach(() => vi.unstubAllGlobals());

describe("Aura-2 asks the speak route only for audio that can play", () => {
  it("never before playback was unlocked by a gesture; once it was, the answer plays there", async () => {
    stubAudio(() => true);
    api.reply = audio;
    const v = await voiceOut();
    expect(await v.speak("Four paychecks need review.")).toBeNull();
    expect(api.calls, "not unlocked: the route is not asked").toBe(0);
    v.primeVoice();
    await tick();
    expect(await v.speak("Four paychecks need review.")).toBe("aura");
    expect(api.calls).toBe(1);
  });

  it("a browser that refuses the gesture's silent clip (no activation) never spends the speech share", async () => {
    stubAudio(() => false);
    api.reply = audio;
    const v = await voiceOut();
    v.primeVoice();
    await tick();
    expect(await v.speak("Four paychecks need review.")).toBeNull();
    expect(api.calls).toBe(0);
  });
});

describe("Aura-2's refusals", () => {
  it("a passing one falls back for that answer only; the next answer asks again", async () => {
    stubAudio(() => true);
    const v = await voiceOut();
    v.primeVoice();
    await tick();
    for (const [status, code] of [[429, "RATE_LIMITED"], [428, "TURNSTILE_REQUIRED"], [503, "AGENT_PAUSED"], [502, "SPEECH_FAILED"]] as const) {
      api.reply = refusal(status, code);
      expect(await v.speak("Four paychecks need review."), code).toBeNull();
    }
    expect(api.calls).toBe(4);
    api.reply = audio;
    expect(await v.speak("Four paychecks need review.")).toBe("aura");
    expect(api.calls).toBe(5);
  });

  it("one that lasts takes Aura out: for the session, or until the day's share refills", async () => {
    stubAudio(() => true);
    let v = await voiceOut();
    v.primeVoice();
    await tick();
    api.reply = refusal(503, "SPEECH_DISABLED");
    await v.speak("One.");
    api.reply = audio;
    expect(await v.speak("Two.")).toBeNull();
    expect(api.calls).toBe(1);

    api.calls = 0;
    v = await voiceOut();
    v.primeVoice();
    await tick();
    api.reply = refusal(429, "SPEECH_BUDGET");
    await v.speak("One.");
    api.reply = audio;
    expect(await v.speak("Two.")).toBeNull();
    expect(api.calls).toBe(1);
  });

  it("names how long each refusal lasts, and the hosted day ends at 00:00 UTC", () => {
    expect(auraRefusalSpan("SPEECH_BUDGET")).toBe("day");
    for (const c of ["SPEECH_DISABLED", "LEASE_REQUIRED", "LEASE_ENDED"]) expect(auraRefusalSpan(c), c).toBe("session");
    for (const c of ["RATE_LIMITED", "TURNSTILE_REQUIRED", "AGENT_PAUSED", "SPEECH_FAILED", "NOT_UNLOCKED", "PLAYBACK", null]) expect(auraRefusalSpan(c), String(c)).toBe("answer");
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 9, 26, 23, 59))).toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 11, 31, 8))).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
