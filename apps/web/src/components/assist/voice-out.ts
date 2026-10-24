"use client";
// Spoken answers (off by default; research/cursor-assistant.md 7.5). The chain voice-core.ts chooses: Chatterbox
// Nano in the browser on WebGPU (downloaded once when the person turns it on, with progress); on the hosted app,
// Deepgram Aura-2 through Weft's own speak route (counted against the speech neuron share and RL_RUN); on either, the
// browser's speech synthesis with a voice the device provides. Text is never sent to any other service.
import { HOSTED_PATHS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { SPEECH_MAX_CHARS } from "../../../../../packages/contracts/src/ext/assist";
import { HOSTED } from "@/lib/hosted/flags";
import { apiFetch } from "@/lib/api/client";
import { auraRefusalSpan, nextUtcMidnight, pickLocalVoice, spokenText, voiceOutChain, type VoiceOutEngine } from "./voice-core";

const failed = new Set<VoiceOutEngine>();
/** Aura-2 sits out until this time (ms): the hosted day's speech share was spent, and it refills at 00:00 UTC. */
let auraOffUntil = 0;
let fileKnown: boolean | null = null;

/** A refusal from the speak route (or playback the browser held back), with its HTTP status and code. */
export class SpeakRefusal extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); }
}

// The one audio element Aura's answers play through. Safari (and any browser without sticky activation) lets an
// element play later, outside a gesture, only once it played inside one; primeVoice does that with a silent clip.
let player: HTMLAudioElement | null = null;
let unlocked = false;

/** A 50 ms silent 8 kHz mono WAV, built here (a blob URL, as the answers are, so the CSP needs nothing new). */
function silentWav(): Blob {
  const n = 400, b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, "data"); b.setUint32(40, n * 2, true);
  return new Blob([b.buffer], { type: "audio/wav" });
}

/**
 * Call inside a person's gesture (a question sent, the microphone, the voice toggle, a choice): it plays a silent
 * clip on the element answers use, so an answer that arrives seconds later may play there. Until it has, the hosted
 * speak route is not asked at all, so no neurons are spent on audio the browser would refuse to play.
 */
export function primeVoice(): void {
  primeSpeech();
  if (unlocked || typeof Audio === "undefined") return;
  try {
    player ??= new Audio();
    const url = URL.createObjectURL(silentWav());
    player.src = url;
    void Promise.resolve(player.play()).then(() => { unlocked = true; player?.pause(); }, () => { unlocked = false; }).finally(() => URL.revokeObjectURL(url));
  } catch { /* no audio element here */ }
}

let speechPrimed = false;
/**
 * The browser's own speech, readied inside the gesture: the voice list starts loading (Chrome fills it only after the
 * first read), and an empty utterance spoken now lets a later answer speak outside a gesture (iOS Safari).
 */
function primeSpeech(): void {
  if (speechPrimed || typeof speechSynthesis === "undefined") return;
  try {
    speechSynthesis.getVoices();
    if (typeof SpeechSynthesisUtterance !== "undefined") { const u = new SpeechSynthesisUtterance(""); u.volume = 0; speechSynthesis.speak(u); }
    speechPrimed = true;
  } catch { /* no speech here */ }
}

/** How long a first answer waits for the browser's voice list to arrive (Chrome returns none until voiceschanged). */
export const VOICES_WAIT_MS = 1_000;

/** The device's voices, waiting once (VOICES_WAIT_MS at most) when the list has not loaded yet. */
async function voicesNow(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === "undefined") return [];
  const now = speechSynthesis.getVoices();
  if (now.length) return now;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); speechSynthesis.removeEventListener?.("voiceschanged", done); resolve(); };
    const t = setTimeout(done, VOICES_WAIT_MS);
    speechSynthesis.addEventListener?.("voiceschanged", done);
  });
  return speechSynthesis.getVoices();
}

export interface SpeakHooks { onProgress?(p: { loaded: number; total: number }): void; onEngine?(e: VoiceOutEngine): void; signal?: AbortSignal }

async function env() {
  const gpu = typeof navigator !== "undefined" && "gpu" in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const jspi = typeof WebAssembly !== "undefined" && "Suspending" in WebAssembly;
  if (fileKnown === null && gpu && jspi) fileKnown = await (await import("./chatterbox")).voiceFileAvailable();
  const voices = await voicesNow();
  const out = Date.now() < auraOffUntil ? new Set<VoiceOutEngine>([...failed, "aura"]) : failed;
  return { webgpu: gpu, jspi, voiceFile: !!fileKnown, hosted: HOSTED, localVoice: !!pickLocalVoice(voices), failed: out };
}

/** The engines this browser would use, in order (the popover names the first). */
export async function voiceEngines(): Promise<VoiceOutEngine[]> { return voiceOutChain(await env()); }

async function aura(text: string, signal?: AbortSignal): Promise<void> {
  // Not unlocked by a gesture yet: the browser would refuse to play, so the route (and its neurons) is never asked.
  const a = player;
  if (!unlocked || !a) throw new SpeakRefusal(0, "NOT_UNLOCKED", "Playback is not allowed yet.");
  const res = await apiFetch(HOSTED_PATHS.speak, { method: "POST", headers: { "content-type": "application/json", accept: "audio/mpeg, application/json" }, body: JSON.stringify({ text: text.slice(0, SPEECH_MAX_CHARS) }), signal });
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) {
    const j = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw new SpeakRefusal(res.status, typeof j?.code === "string" ? j.code : null, j?.message ?? `Spoken answers are not available right now (${res.status}).`);
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    a.src = url;
    await new Promise<void>((resolve, reject) => {
      a.onended = () => resolve();
      a.onerror = () => reject(new SpeakRefusal(0, "PLAYBACK", "The audio could not play."));
      signal?.addEventListener("abort", () => { a.pause(); resolve(); }, { once: true });
      void Promise.resolve(a.play()).catch((e: unknown) => { if (e instanceof Error && e.name === "NotAllowedError") unlocked = false; reject(new SpeakRefusal(0, "PLAYBACK", "The audio could not play.")); });
    });
  } finally { URL.revokeObjectURL(url); }
}

function browser(text: string, signal?: AbortSignal): Promise<void> {
  const voice = pickLocalVoice(speechSynthesis.getVoices());
  if (!voice) return Promise.reject(new Error("No voice on this device."));
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new Error(e.error)));
    signal?.addEventListener("abort", () => speechSynthesis.cancel(), { once: true });
    speechSynthesis.speak(u);
  });
}

/** Speaks an answer through the first engine that works; returns the engine used, or null when none could. */
export async function speak(answer: string, hooks: SpeakHooks = {}): Promise<VoiceOutEngine | null> {
  const text = spokenText(answer, 600);
  if (!text) return null;
  const stopped = () => !!hooks.signal?.aborted;
  for (const engine of voiceOutChain(await env())) {
    if (stopped()) return null;
    try {
      hooks.onEngine?.(engine);
      if (engine === "chatterbox") {
        const cb = await import("./chatterbox");
        // Progress only while this answer is still wanted; once it is not, the (shared, cached) download carries on
        // silently and the old answer is never spoken.
        const m = await cb.loadChatterbox((p) => { if (!stopped()) hooks.onProgress?.(p); });
        if (stopped()) return null;
        const wave = await cb.synthesize(m, text);
        if (stopped()) return null;
        await cb.playWave(wave, hooks.signal);
      } else if (engine === "aura") await aura(spokenText(answer, SPEECH_MAX_CHARS), hooks.signal);
      else await browser(text, hooks.signal);
      return engine;
    } catch (e) {
      // Stopped by the person (a new question, the card closed, voice turned off): not a failure of the engine.
      if (stopped()) return null;
      // The browser's own speech failing once (busy audio, a synthesis error, a first speak outside a gesture) is
      // this answer's: the next answer tries it again. A failed in-browser voice download stays out for the session.
      if (engine === "browser") continue;
      if (engine !== "aura") { failed.add(engine); continue; }
      // Aura's refusals mostly pass (a rate limit, a check, a pause, one failed call): this answer falls back, and
      // only one that lasts takes Aura out, for the session or until the day's share refills.
      const span = auraRefusalSpan(e instanceof SpeakRefusal ? e.code : null);
      if (span === "session") failed.add("aura");
      else if (span === "day") auraOffUntil = nextUtcMidnight(Date.now());
    }
  }
  return null;
}

/** Stops whatever is speaking. */
export function stopSpeaking(): void { try { speechSynthesis.cancel(); } catch { /* none */ } }
