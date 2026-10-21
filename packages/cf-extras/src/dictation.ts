// Dictation (design 5.4): the Dictate button in the composer sends a clip of at most 30 s, whisper-large-v3-turbo
// transcribes it through AI Gateway (measured correct on a 3 s clip, 46.63 neurons per audio minute), and the text
// fills the composer. It is never sent on its own: the person reads it and presses Send. Dictation has its own
// share of 300 neurons a day in SpendDO and the `extras.dictation` kill flag. Track cf6-extras.
import { DICTATION_MAX_SECONDS, DICTATION_MODEL, type Dictation, type DictationResult } from "../../contracts/src/ext/cf-extras";
import type { AiGatewayOption, WorkersAiBindingLike } from "./bindings";
import { cleanText, sniff, toBase64 } from "./bytes";
import { DICTATION_RESERVE_NEURONS, dictationNeurons, type NeuronBudget } from "./neurons";

/** 30 s of compressed speech is far under this; a larger body is refused before any model call. */
export const DICTATION_MAX_BYTES = 1_000_000;
export const DICTATION_MAX_TEXT = 2_000;

export interface DictationDeps {
  ai: WorkersAiBindingLike;
  neurons: NeuronBudget;
  enabled: () => boolean | Promise<boolean>;
  gateway?: AiGatewayOption | null;
  charge?: { world?: string | null; visitor?: string | null; ipHash?: string | null };
}

/** Seconds of audio in a PCM WAV from its header, or null when it is not one. */
export function wavSeconds(b: Uint8Array): number | null {
  if (sniff(b) !== "wav" || b.length < 44) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt " && off + 16 <= b.length) byteRate = dv.getUint32(off + 16, true);
    if (id === "data") return byteRate > 0 ? Math.min(size, b.length - off - 8) / byteRate : null;
    off += 8 + size + (size % 2);
  }
  return null;
}

const AUDIO = new Set(["wav", "webm", "ogg", "mp4", "mp3"]);

export function createDictation(deps: DictationDeps): Dictation {
  return {
    async transcribe(input): Promise<DictationResult> {
      if (!(await deps.enabled())) return { ok: false, code: "DICTATION_DISABLED", message: "Dictation is switched off" };
      const audio = input.audio;
      if (audio.length === 0 || !AUDIO.has(sniff(audio))) return { ok: false, code: "DICTATION_UNREADABLE", message: "Send a short audio clip (WAV, WebM, Ogg, MP4 or MP3)" };
      if (audio.length > DICTATION_MAX_BYTES) return { ok: false, code: "DICTATION_TOO_LONG", message: `Clips are at most ${DICTATION_MAX_SECONDS} seconds` };
      const headerSeconds = wavSeconds(audio);
      if (headerSeconds !== null && headerSeconds > DICTATION_MAX_SECONDS + 0.5) return { ok: false, code: "DICTATION_TOO_LONG", message: `Clips are at most ${DICTATION_MAX_SECONDS} seconds` };
      const rsv = await deps.neurons.reserve({ product: "dictation", neurons: DICTATION_RESERVE_NEURONS, model: DICTATION_MODEL, ...deps.charge });
      if (!rsv.ok) return { ok: false, code: "DICTATION_BUDGET", message: "Today's dictation budget is used up; it is back after 00:00 UTC" };
      let out: unknown;
      try {
        out = await deps.ai.run(DICTATION_MODEL, { audio: toBase64(audio), task: "transcribe", language: "en", vad_filter: true }, deps.gateway ? { gateway: deps.gateway } : undefined);
      } catch (e) {
        await deps.neurons.settle(rsv.reservationId, DICTATION_RESERVE_NEURONS);
        throw e;
      }
      const o = (out ?? {}) as { text?: unknown; transcription_info?: { duration?: unknown } };
      const reported = typeof o.transcription_info?.duration === "number" ? o.transcription_info.duration : null;
      const seconds = Math.round((reported ?? headerSeconds ?? DICTATION_MAX_SECONDS) * 100) / 100;
      const neurons = Math.min(DICTATION_RESERVE_NEURONS, dictationNeurons(seconds));
      await deps.neurons.settle(rsv.reservationId, neurons);
      if (seconds > DICTATION_MAX_SECONDS + 0.5) return { ok: false, code: "DICTATION_TOO_LONG", message: `Clips are at most ${DICTATION_MAX_SECONDS} seconds` };
      const text = typeof o.text === "string" ? cleanText(o.text, DICTATION_MAX_TEXT).replace(/\s+/g, " ").trim() : "";
      if (!text) return { ok: false, code: "DICTATION_UNREADABLE", message: "No speech was heard in the clip" };
      return { ok: true, text, seconds, neurons };
    },
  };
}
