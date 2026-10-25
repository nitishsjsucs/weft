"use client";
// The cursor assistant's per-browser preferences (localStorage, every access guarded): whether the floating icon
// shows (the Viewing as menu toggles it; the hotkey and the right-click menu work either way) and whether answers
// are spoken (off by default).
import { useSyncExternalStore } from "react";

const KEYS = { icon: "weft.assist.icon", voice: "weft.assist.voice" } as const;
type Key = keyof typeof KEYS;
const subs = new Set<() => void>();
/** This page's own choices: with storage blocked (site data turned off) a choice still holds until the page reloads. */
const chosen = new Map<Key, string>();
/** "on", "off" or null (never chosen): this page's choice first, then the browser's stored one. */
export function readAssistPref(k: Key): string | null {
  const mine = chosen.get(k);
  if (mine !== undefined) return mine;
  try { return window.localStorage.getItem(KEYS[k]); } catch { return null; }
}
const read = readAssistPref;

export function setAssistPref(k: Key, on: boolean): void {
  chosen.set(k, on ? "on" : "off");
  try { window.localStorage.setItem(KEYS[k], on ? "on" : "off"); } catch { /* storage blocked: the choice lasts for this page */ }
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** The icon shows unless it was turned off. */
export function useAssistIcon(): boolean { return useSyncExternalStore(subscribe, () => read("icon") !== "off", () => true); }
/** Spoken answers are off unless they were turned on. */
export function useAssistVoice(): boolean { return useSyncExternalStore(subscribe, () => read("voice") === "on", () => false); }
