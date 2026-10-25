// Which voice paths a browser has (research/cursor-assistant.md 4.4 and 7.4 to 7.5), as pure decisions so vitest covers
// every fallback. Voice in: the browser's live speech recognition with a live transcript where it exists; otherwise
// a 16 kHz WAV clip to the hosted dictation route (hosted only); otherwise none (local without speech recognition:
// type instead). Voice out (off by default): Chatterbox Nano in the browser on WebGPU when it can run here; then, on
// the hosted app, Deepgram Aura-2 through Weft's own speak route; then the browser's built-in speech synthesis with a
// voice the device itself provides (localService), never one that sends the text to another service.
export type VoiceInMode = "live" | "record" | "none";
export type VoiceOutEngine = "chatterbox" | "aura" | "browser";

export interface VoiceInEnv { speechRecognition: boolean; mediaRecorder: boolean; getUserMedia: boolean; hosted: boolean }
export function voiceInMode(e: VoiceInEnv): VoiceInMode {
  if (e.speechRecognition) return "live";
  if (e.hosted && e.mediaRecorder && e.getUserMedia) return "record";
  return "none";
}

export interface VoiceOutEnv {
  /** navigator.gpu with an adapter. */
  webgpu: boolean;
  /** The adapter offers 'shader-f16' (the language model's key and value cache is float16). */
  shaderF16: boolean;
  /** WebAssembly JS Promise Integration (the JSPI build of ONNX Runtime Web the in-browser voice runs on). */
  jspi: boolean;
  /** The fixed voice this server ships (public/assist/voice/weft-voice.bin). */
  voiceFile: boolean;
  hosted: boolean;
  /** A speech synthesis voice the device provides itself. */
  localVoice: boolean;
  /** Engines that failed in this session (a failed download, a session that would not start). */
  failed: ReadonlySet<VoiceOutEngine>;
}
/** The engines to try, in order; empty means no spoken answers here. */
export function voiceOutChain(e: VoiceOutEnv): VoiceOutEngine[] {
  const out: VoiceOutEngine[] = [];
  if (e.webgpu && e.shaderF16 && e.jspi && e.voiceFile && !e.failed.has("chatterbox")) out.push("chatterbox");
  if (e.hosted && !e.failed.has("aura")) out.push("aura");
  if (e.localVoice && !e.failed.has("browser")) out.push("browser");
  return out;
}

/** A voice the device itself provides (localService), preferring English; null when every voice is a network one. */
export function pickLocalVoice<T extends { localService: boolean; lang: string; default?: boolean }>(voices: readonly T[]): T | null {
  const local = voices.filter((v) => v.localService);
  return local.find((v) => /^en(-|$)/i.test(v.lang) && v.default) ?? local.find((v) => /^en(-|$)/i.test(v.lang)) ?? local[0] ?? null;
}

/** What a spoken answer says: the answer's words without citation chips, ids or markup, cut at a sentence near `max`. */
export function spokenText(answer: string, max: number): string {
  const plain = answer.replace(/\[(?:res|art)_[A-Za-z0-9_]+\]/g, "").replace(/\b[a-z]{2,5}_[A-Za-z0-9_]*\d[A-Za-z0-9_]*\b/g, "").replace(/[*`#_]+/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")).trim();
}

/**
 * How long a refusal from the hosted speak route keeps Aura-2 out of the chain: the session for one that lasts
 * (spoken answers turned off, no lease, a session the Worker no longer knows), until 00:00 UTC for the day's spent
 * speech share, and only the answer at hand for anything passing (a rate limit shared with runs and dictation, a
 * check to pass, a short pause, one failed call, playback the browser held back). The next answer tries Aura again.
 */
export function auraRefusalSpan(code: string | null | undefined): "session" | "day" | "answer" {
  if (code === "SPEECH_BUDGET") return "day";
  if (code && ["SPEECH_DISABLED", "LEASE_REQUIRED", "LEASE_ENDED", "SESSION_INVALID", "ORIGIN_REFUSED", "NOT_CONFIGURED"].includes(code)) return "session";
  return "answer";
}

/** The next 00:00 UTC after `now` (ms), when the hosted day's shares refill. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
