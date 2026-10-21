"use client";
// The Dictate button in the agent composer (docs/cloudflare/design.md 5.4): records at most 30 s in the browser,
// sends the clip to /api/_hosted/dictate (Workers AI whisper-large-v3-turbo) and puts the text in the composer. The
// text is never sent on its own. Dictation counts as a mutation at the edge, so it goes through the hosted fetch.
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@weft/ui";
import { HOSTED_PATHS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { DICTATION_MAX_SECONDS, type DictationResult } from "../../../../../packages/contracts/src/ext/cf-extras";
import { apiFetch } from "@/lib/api/client";

/** POST the clip; the text, or an error line. Exported for tests. */
export async function transcribe(audio: Blob, f: typeof fetch = apiFetch): Promise<string> {
  const res = await f(HOSTED_PATHS.dictate, { method: "POST", headers: { accept: "application/json", "content-type": audio.type || "audio/webm" }, body: audio });
  const j = (await res.json().catch(() => null)) as (DictationResult & { message?: string }) | null;
  if (!res.ok || !j) throw new Error(j?.message ?? `Dictation failed (${res.status}).`);
  if (!j.ok) throw new Error(j.message);
  return j.text.trim();
}

/** Appends dictated text to what is already in the composer. Exported for tests. */
export function appendDictation(current: string, text: string): string {
  if (!text) return current;
  return current.trim() ? `${current.replace(/\s+$/, "")} ${text}` : text;
}

export function DictateButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (stopTimer.current) clearTimeout(stopTimer.current); rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);
  const supported = typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      rec.current = r;
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
        const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
        setState("sending");
        void transcribe(blob).then(onText, (e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setState("idle"));
      };
      r.start();
      setState("recording");
      stopTimer.current = setTimeout(() => { if (r.state === "recording") r.stop(); }, DICTATION_MAX_SECONDS * 1000);
    } catch (e) {
      setError(e instanceof Error && e.name === "NotAllowedError" ? "The browser did not allow the microphone." : "Dictation could not start.");
      setState("idle");
    }
  };
  const stop = () => { if (rec.current?.state === "recording") rec.current.stop(); };
  if (!supported) return null;
  return (
    <>
      <button
        type="button"
        data-testid="hosted-dictate"
        data-state={state}
        disabled={state === "sending"}
        onClick={() => (state === "recording" ? stop() : void start())}
        aria-pressed={state === "recording"}
        title={`Dictate (up to ${DICTATION_MAX_SECONDS} s); the text goes in the box, not to the agent`}
        className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-1 text-gray-11 shadow-[var(--shadow-border)] hover:bg-gray-2 disabled:opacity-50", state === "recording" && "bg-red-3 text-red-11")}
      >
        {state === "recording" ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
        {state === "recording" ? "Stop" : state === "sending" ? "Writing..." : "Dictate"}
      </button>
      {error ? <span role="alert" className="text-1 text-red-11">{error}</span> : null}
    </>
  );
}
