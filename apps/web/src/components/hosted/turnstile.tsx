"use client";
// The Turnstile widget (docs/cloudflare/design.md 6.2). The script loads from challenges.cloudflare.com only when a
// widget is first needed (never on the landing). Local and Miniflare runs use Cloudflare's published test sitekey;
// the deploy build passes the `weft` widget's sitekey. The token goes straight to the front Worker, which verifies it.
import { useEffect, useRef } from "react";
import { TURNSTILE_SCRIPT, TURNSTILE_SITEKEY } from "@/lib/hosted/flags";

export interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string | undefined;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: TurnstileApi } }

let loading: Promise<TurnstileApi> | null = null;

/** Loads api.js once (explicit rendering). */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((ok, fail) => {
    const s = doc.createElement("script");
    s.src = TURNSTILE_SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? ok(window.turnstile) : fail(new Error("Turnstile did not load")));
    s.onerror = () => { loading = null; fail(new Error("Turnstile did not load")); };
    doc.head.appendChild(s);
  });
  return loading;
}

/**
 * One widget. `appearance: "interaction-only"` stays invisible unless the visitor has to click (the 428 refresh);
 * "always" shows the managed widget (lease start). `nonce` remounts it, since each token is single use.
 */
export function TurnstileWidget({ action, appearance = "always", nonce = 0, onToken, onError }: {
  action: string; appearance?: "always" | "interaction-only"; nonce?: number;
  onToken: (token: string) => void; onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef({ onToken, onError });
  cb.current = { onToken, onError };
  useEffect(() => {
    let id: string | undefined;
    let api: TurnstileApi | null = null;
    let live = true;
    loadTurnstile().then((ts) => {
      if (!live || !ref.current) return;
      api = ts;
      id = ts.render(ref.current, {
        sitekey: TURNSTILE_SITEKEY,
        action,
        appearance,
        callback: (token: string) => cb.current.onToken(token),
        "error-callback": () => { cb.current.onError("The check could not run. Try again."); return true; },
        "expired-callback": () => cb.current.onError("The check expired. Try again."),
      });
    }, (e: unknown) => cb.current.onError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; if (api && id) try { api.remove(id); } catch { /* gone */ } };
  }, [action, appearance, nonce]);
  return <div ref={ref} data-testid="hosted-turnstile" data-action={action} className="min-h-[65px]" />;
}
