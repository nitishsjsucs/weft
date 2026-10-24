// The cursor assistant's spoken answers on the hosted app (ext/assist.ts re-exports these): Deepgram Aura-2 on Workers
// AI behind POST HOSTED_PATHS.speak (cf-hosted.ts), when the browser cannot run the voice model itself. Constants and
// types only, with no zod, so the extras Worker that serves the route imports nothing heavy.

/** Deepgram Aura-2 on Workers AI ($0.030 per 1,000 characters, Workers AI pricing page, 2026-10-24). */
export const SPEECH_MODEL = "@cf/deepgram/aura-2-en";
/** A fixed voice. */
export const SPEECH_SPEAKER = "thalia";
/** At most this much of an answer is spoken by the hosted route (492 neurons, about $0.0054). */
export const SPEECH_MAX_CHARS = 180;
/** $0.030 per 1,000 characters at $0.011 per 1,000 neurons. */
export const SPEECH_NEURONS_PER_K_CHARS = 2_728;
export const speechNeurons = (chars: number): number => Math.max(1, Math.ceil((Math.max(0, chars) * SPEECH_NEURONS_PER_K_CHARS) / 1000));
export type SpeechRefusal = { ok: false; code: "SPEECH_DISABLED" | "SPEECH_BUDGET" | "SPEECH_TOO_LONG" | "SPEECH_EMPTY" | "SPEECH_FAILED"; message: string };
/** The hosted route answers audio/mpeg on success, else this JSON. */
export interface SpeechInput { text: string }
/** The speak route's body cap: { text } of SPEECH_MAX_CHARS needs far less. */
export const SPEECH_BODY_BYTES = 2_048;
