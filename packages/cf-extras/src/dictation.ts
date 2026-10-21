// Dictation (design 5.4): the Dictate button in the composer sends a clip of at most 30 s, whisper-large-v3-turbo
// transcribes it through AI Gateway (measured correct on a 3 s clip, 46.63 neurons per audio minute), and the text
// fills the composer. It is never sent on its own: the person reads it and presses Send. Dictation has its own
// share of 300 neurons a day in SpendDO and the `extras.dictation` kill flag.
//
// The length is checked before any model call, so a clip is never transcribed (and paid for) and then refused: only
// PCM WAV is accepted, whose length follows from its byte count (wav.ts), and a clip over 30 s is refused at once. The
// reservation is that length's cost; the settle is the longer of it and the duration the model reports, so the
// ledger never records less than the call used. Track cf6-extras.
import { DICTATION_MAX_SECONDS, DICTATION_MODEL, type Dictation, type DictationResult } from "../../contracts/src/ext/cf-extras";
import type { AiGatewayOption, WorkersAiBindingLike } from "./bindings";
import { cleanText, sniff, toBase64 } from "./bytes";
import { DICTATION_SLACK_SECONDS, dictationNeurons, type NeuronBudget } from "./neurons";
import { pcmWavInfo } from "./wav";

/** 30 s of 16 kHz mono 16-bit PCM is 960,044 bytes; a larger body is refused before any model call. */
export const DICTATION_MAX_BYTES = 1_000_000;
export const DICTATION_MAX_TEXT = 2_000;

export interface DictationDeps {
  ai: WorkersAiBindingLike;
  neurons: NeuronBudget;
  enabled: () => boolean | Promise<boolean>;
  gateway?: AiGatewayOption | null;
  charge?: { world?: string | null; visitor?: string | null; ipHash?: string | null };
}

/** Seconds of audio in a PCM WAV (an upper bound from its byte count), or null when it is not one. */
export function wavSeconds(b: Uint8Array): number | null {
  return pcmWavInfo(b)?.seconds ?? null;
}

const COMPRESSED = new Set(["webm", "ogg", "mp4", "mp3"]);
const TOO_LONG = `Clips are at most ${DICTATION_MAX_SECONDS} seconds`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function createDictation(deps: DictationDeps): Dictation {
  return {
    async transcribe(input): Promise<DictationResult> {
      if (!(await deps.enabled())) return { ok: false, code: "DICTATION_DISABLED", message: "Dictation is switched off" };
      const audio = input.audio;
      if (audio.length > DICTATION_MAX_BYTES) return { ok: false, code: "DICTATION_TOO_LONG", message: TOO_LONG };
      const info = audio.length > 0 ? pcmWavInfo(audio) : null;
      if (!info) {
        const why = COMPRESSED.has(sniff(audio))
          ? "Send the clip as 16-bit PCM WAV: a compressed clip's length cannot be checked before it is transcribed"
          : "Send a short audio clip as 16-bit PCM WAV";
        return { ok: false, code: "DICTATION_UNREADABLE", message: why };
      }
      if (info.seconds > DICTATION_MAX_SECONDS + DICTATION_SLACK_SECONDS) return { ok: false, code: "DICTATION_TOO_LONG", message: TOO_LONG };
      const reserved = Math.max(1, dictationNeurons(info.seconds));
      const rsv = await deps.neurons.reserve({ product: "dictation", neurons: reserved, model: DICTATION_MODEL, ...deps.charge });
      if (!rsv.ok) return { ok: false, code: "DICTATION_BUDGET", message: "Today's dictation budget is used up; it is back after 00:00 UTC" };
      let out: unknown;
      try {
        out = await deps.ai.run(DICTATION_MODEL, { audio: toBase64(audio), task: "transcribe", language: "en", vad_filter: true }, deps.gateway ? { gateway: deps.gateway } : undefined);
      } catch (e) {
        // A failed call may still have used neurons, so it settles at its worst case.
        await deps.neurons.settle(rsv.reservationId, reserved);
        throw e;
      }
      const o = (out ?? {}) as { text?: unknown; transcription_info?: { duration?: unknown } };
      const d = o.transcription_info?.duration;
      const reported = typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : null;
      // The longer of the two lengths is what the ledger records, so it never holds less than the call used.
      const billed = Math.max(reported ?? 0, info.seconds);
      const neurons = Math.max(reserved, dictationNeurons(billed));
      await deps.neurons.settle(rsv.reservationId, neurons);
      if (billed > DICTATION_MAX_SECONDS + DICTATION_SLACK_SECONDS) return { ok: false, code: "DICTATION_TOO_LONG", message: TOO_LONG };
      const text = typeof o.text === "string" ? cleanText(o.text, DICTATION_MAX_TEXT).replace(/\s+/g, " ").trim() : "";
      if (!text) return { ok: false, code: "DICTATION_UNREADABLE", message: "No speech was heard in the clip" };
      return { ok: true, text, seconds: round2(reported ?? info.seconds), neurons };
    },
  };
}
