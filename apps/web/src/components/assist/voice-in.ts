"use client";
// Voice in for the cursor assistant (research/cursor-assistant.md 7.4): the browser's live speech recognition with a
// live transcript where it exists; otherwise, on the hosted app, a clip recorded as 16 kHz mono WAV and sent to
// Weft's own dictation route (Workers AI whisper); otherwise none, and the composer says to type. A refused
// microphone is said plainly. Nothing is sent anywhere else.
import { HOSTED } from "@/lib/hosted/flags";
import { toDictationWav, transcribe } from "../hosted/dictate-button";
import { voiceInMode, type VoiceInMode } from "./voice-core";

interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;
const ctor = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function browserVoiceInMode(): VoiceInMode {
  return voiceInMode({
    speechRecognition: !!ctor(), hosted: HOSTED,
    mediaRecorder: typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined",
    getUserMedia: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  });
}

export const VOICE_COPY = {
  none: "Voice is not available in this browser. Type your question instead.",
  denied: "The browser did not allow the microphone. Type your question, or allow the microphone and try again.",
  noSpeech: "No speech was heard. Try again, or type.",
  failed: "Voice input stopped. Type your question instead.",
} as const;

export interface Listening { stop(): void; cancel(): void }
export interface ListenHandlers { onPartial(text: string): void; onFinal(text: string): void; onError(message: string): void; onState?(s: "listening" | "transcribing" | "idle"): void }

/** The mode to try when live recognition fails for want of its service (hosted only: the dictation route is Weft's own). */
export function fallbackMode(error: string, hosted = HOSTED, recordable = browserCanRecord()): VoiceInMode | null {
  return (error === "network" || error === "service-not-allowed") && hosted && recordable ? "record" : null;
}
const browserCanRecord = () => typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * Starts listening in the best mode this browser has; `stop` ends the clip (the transcript arrives in onFinal). Live
 * recognition whose service is unreachable (a network error, a browser that blocks the service) starts over once in
 * record mode on the hosted app, so the person can still speak.
 */
export function listen(h: ListenHandlers, mode: VoiceInMode = browserVoiceInMode()): Listening {
  if (mode === "live") {
    let inner: Listening | null = null;
    const R = ctor()!;
    const r = new R();
    r.lang = "en-US"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let final = "";
    let done = false;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) final += res[0]!.transcript; else interim += res[0]!.transcript;
      }
      h.onPartial(`${final}${interim}`.trim());
    };
    r.onerror = (e) => {
      if (done) return;
      done = true;
      const next = fallbackMode(e.error);
      if (next && !final.trim()) { inner = listen(h, next); return; }
      h.onState?.("idle");
      h.onError(e.error === "not-allowed" || e.error === "service-not-allowed" ? VOICE_COPY.denied : e.error === "no-speech" ? VOICE_COPY.noSpeech : VOICE_COPY.failed);
    };
    r.onend = () => { if (done) return; done = true; h.onState?.("idle"); if (final.trim()) h.onFinal(final.trim()); else h.onError(VOICE_COPY.noSpeech); };
    try { r.start(); h.onState?.("listening"); } catch { done = true; h.onError(VOICE_COPY.failed); }
    return {
      stop: () => { if (inner) inner.stop(); else try { r.stop(); } catch { /* ended */ } },
      cancel: () => { if (inner) { inner.cancel(); return; } done = true; try { r.abort(); } catch { /* ended */ } h.onState?.("idle"); },
    };
  }
  if (mode === "record") {
    let rec: MediaRecorder | null = null;
    let cancelled = false;
    // Stop pressed while the browser still asks for the microphone: there is no clip yet, so none is recorded.
    let stopEarly = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (stopEarly) { stream.getTracks().forEach((t) => t.stop()); h.onState?.("idle"); h.onError(VOICE_COPY.noSpeech); return; }
        const chunks: Blob[] = [];
        rec = new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          clearTimeout(timer);
          stream.getTracks().forEach((t) => t.stop());
          if (cancelled) return;
          h.onState?.("transcribing");
          void toDictationWav(new Blob(chunks, { type: rec!.mimeType || "audio/webm" }))
            .then((wav) => transcribe(wav))
            // Cancelled while the clip was being written down: the transcript is dropped, never asked.
            .then((t) => { if (cancelled) return; h.onState?.("idle"); if (t) h.onFinal(t); else h.onError(VOICE_COPY.noSpeech); }, (e: unknown) => { if (cancelled) return; h.onState?.("idle"); h.onError(e instanceof Error ? e.message : VOICE_COPY.failed); });
        };
        rec.start();
        // The 15 s cap counts from when the clip starts, not from the permission prompt (which may take longer).
        timer = setTimeout(() => { if (rec?.state === "recording") rec.stop(); }, 15_000);
        h.onState?.("listening");
      } catch (e) {
        clearTimeout(timer);
        // Cancelled during the prompt (Escape, a new question): a denial that arrives later says nothing, so it can
        // never clear or note over a newer listening session.
        if (cancelled) return;
        h.onState?.("idle");
        h.onError(e instanceof Error && e.name === "NotAllowedError" ? VOICE_COPY.denied : VOICE_COPY.failed);
      }
    })();
    return {
      stop: () => { if (rec?.state === "recording") rec.stop(); else if (!rec) stopEarly = true; },
      cancel: () => { cancelled = true; clearTimeout(timer); if (rec?.state === "recording") rec.stop(); h.onState?.("idle"); },
    };
  }
  queueMicrotask(() => h.onError(VOICE_COPY.none));
  return { stop: () => undefined, cancel: () => undefined };
}
