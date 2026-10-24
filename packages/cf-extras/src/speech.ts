// Spoken answers (the cursor assistant, packages/contracts/src/ext/assist.ts): when the browser cannot run the voice
// model itself, the hosted app speaks a short answer with Deepgram Aura-2 on Workers AI through AI Gateway. The text
// is checked before any model call (at most SPEECH_MAX_CHARS once trimmed, so a long answer is never spoken and then
// refused); the reservation is the text's exact cost (Aura-2 is priced per character), counted against the speech
// share of the neuron day cap in SpendDO; a failed call settles at that worst case. Speech has its own
// `extras.speech` kill flag. The audio goes back to the person who asked and is never stored.
import { SPEECH_MAX_CHARS, SPEECH_MODEL, SPEECH_SPEAKER, speechNeurons, type SpeechRefusal } from "../../contracts/src/ext/assist-speech";
import type { AiGatewayOption, WorkersAiBindingLike } from "./bindings";
import { cleanText } from "./bytes";
import type { NeuronBudget } from "./neurons";

/** More audio than a 180-character answer ever makes (about 15 s of MP3 is 250 KB): a bigger reply is refused. */
export const SPEECH_MAX_AUDIO_BYTES = 2 * 1024 * 1024;

export type SpeechResult = { ok: true; audio: Uint8Array; contentType: "audio/mpeg"; chars: number; neurons: number } | SpeechRefusal;
export interface Speech { speak(input: { text: string }): Promise<SpeechResult> }

export interface SpeechDeps {
  ai: WorkersAiBindingLike;
  neurons: NeuronBudget;
  enabled: () => boolean | Promise<boolean>;
  gateway?: AiGatewayOption | null;
  charge?: { world?: string | null; visitor?: string | null; ipHash?: string | null };
}

/** The text as it is spoken: control characters out, whitespace collapsed, trimmed. */
export function speechText(text: unknown): string {
  return typeof text === "string" ? cleanText(text, SPEECH_MAX_CHARS * 4).replace(/\s+/g, " ").trim() : "";
}

/** The audio bytes from what the binding returns: raw bytes, a stream, a Response, or { audio: base64 }. */
async function audioOf(out: unknown): Promise<Uint8Array | null> {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof Response !== "undefined" && out instanceof Response) return out.ok ? new Uint8Array(await out.arrayBuffer()) : null;
  if (typeof ReadableStream !== "undefined" && out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  const b64 = (out as { audio?: unknown } | null)?.audio;
  if (typeof b64 === "string" && /^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return null;
}

const refusal = (code: SpeechRefusal["code"], message: string): SpeechRefusal => ({ ok: false, code, message });

export function createSpeech(deps: SpeechDeps): Speech {
  return {
    async speak(input): Promise<SpeechResult> {
      if (!(await deps.enabled())) return refusal("SPEECH_DISABLED", "Spoken answers are switched off");
      const text = speechText(input.text);
      if (!text) return refusal("SPEECH_EMPTY", "There is nothing to say");
      if (text.length > SPEECH_MAX_CHARS) return refusal("SPEECH_TOO_LONG", `Spoken answers are at most ${SPEECH_MAX_CHARS} characters`);
      const neurons = speechNeurons(text.length);
      const rsv = await deps.neurons.reserve({ product: "speech", neurons, model: SPEECH_MODEL, ...deps.charge });
      if (!rsv.ok) return refusal("SPEECH_BUDGET", "Today's spoken answers are used up; they are back after 00:00 UTC");
      let audio: Uint8Array | null = null;
      try {
        audio = await audioOf(await deps.ai.run(SPEECH_MODEL, { text, speaker: SPEECH_SPEAKER, encoding: "mp3" }, deps.gateway ? { gateway: deps.gateway } : undefined));
      } catch {
        audio = null;
      }
      // The price is per character, so the reservation is what the call cost, whether it worked or not.
      await deps.neurons.settle(rsv.reservationId, neurons);
      if (!audio || audio.byteLength === 0 || audio.byteLength > SPEECH_MAX_AUDIO_BYTES) return refusal("SPEECH_FAILED", "The answer could not be spoken right now");
      return { ok: true, audio, contentType: "audio/mpeg", chars: text.length, neurons };
    },
  };
}
