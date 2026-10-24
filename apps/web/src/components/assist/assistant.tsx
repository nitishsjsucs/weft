"use client";
// The cursor assistant (research/cursor-assistant.md, phases 1 and 2; the manifest is packages/contracts/src/ext/
// assist.ts). Mounted once in the app shell, so the marketing pages and the portal keep the browser's own menu. It owns
// the surfaces and the state between them: the floating icon, the small Weft menu a right-click opens, the composer
// (typed, or spoken after a double right-click), and one card next to the pointer that shows the run working, its
// answer with any approval card, "Show me" chips and choices, or the progress of the full agent a request was handed
// to. Each question is an `assist` run (POST /v1/agent/runs) with the screen map, the cursor context, the records the
// page holds and the trail; the client plays the presentation effects the run's steps carry (effects.ts) once their
// step is settled. Nothing here approves, submits, saves, deletes, sends or runs anything: a change is a proposal and
// its approval card is the person's to press.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, CircleAlert, Clock, ExternalLink, Mic, ShieldAlert, Sparkles, Square, Volume2, VolumeX, X } from "lucide-react";
import { ShimmerText } from "@weft/ui/components";
import { cn } from "@weft/ui";
import type { ProposalStatus, RunStatus, RunStepRow } from "@weft/contracts";
import {
  ASSIST_ANCHORS, ASSIST_TID, checkIntent, checkRoute, choiceText, fillSelectors, type AssistRunAccepted, type ClosingChip, type EntityRef, type WalkStepEffect,
} from "../../../../../packages/contracts/src/ext/assist";
import { client, errorText, getPrincipal, invalidate, mountedQueries, rawFetch } from "@/lib/api/hooks";
import { isTerminal, watchRun, type RunWatch } from "@/lib/api/sse";
import { HOSTED } from "@/lib/hosted/flags";
import { normalizePath } from "@/lib/pathname";
import { followInPlace } from "@/lib/url-state";
import { useTour } from "../tour/tour-provider";
import { useAgent } from "../app/agent-context";
import type { Rect } from "../tour/geometry";
import { AnswerView } from "../app/agent/answer-view";
import { ApprovalCard } from "../app/agent/approval-card";
import { stepSummary } from "../app/agent/run-steps";
import { taintText } from "../app/agent/untrusted";
import { newThreadId, selectionHref } from "../app/agent-page/threads";
import { ASSIST_COPY } from "./copy";
import { buildCursor, captureStart, keyboardStart, lastPointer, startCursorTracking, type CursorStart } from "./context";
import { PREFIX_KIND } from "./context-core";
import { openLayer, readScreen, type Registered } from "./dom";
import { applyEffect, type EffectEnv } from "./effects";
import { offeredIntents } from "./intents";
import { setAssistPref, useAssistIcon, useAssistVoice } from "./prefs";
import { summarizeRecords } from "./records-core";
import { createRightClickDetector } from "./right-click";
import { cardTaint, chipLabel, clipAnswer, effectTrailLabel, fitAssistRequest, playableEffects, progressSteps, refusedChange, type AssistTrace } from "./run-core";
import { iconHidden, mayShowNow, sheetReserve, viewPatch } from "./surface-core";
import { pushTrail, startTrail, syncTrail, trailEvents } from "./trail";
import { AssistPointer, CursorIcon, FloatingCard, InLayer, useLayerHost, useTrackedRect, WeftMenu } from "./visuals";
import { browserVoiceInMode, listen, VOICE_COPY, type Listening } from "./voice-in";
import { primeVoice, speak, stopSpeaking } from "./voice-out";
import { WalkPlayer } from "./walk";

function useMedia(q: string): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** A run is over for the card: finished, or (a handoff's chat run) waiting on a person's approval. */
const ended = (s: RunStatus | undefined) => isTerminal(s) || s === "waiting" || s === "held";
const traceOf = (w: RunWatch | null): AssistTrace | null => (w?.trace as AssistTrace | null) ?? null;
const agentHref = (threadId: string) => selectionHref("/app/agent", { kind: "thread", threadId });

interface Exchange {
  id: number;
  question: string;
  threadId: string;
  assistId: string | null;
  assist: RunWatch | null;
  chatId: string | null;
  chat: RunWatch | null;
  error: string | null;
  stopped: boolean;
}
interface Pointing { key: number; target: HTMLElement; label: string; from: { x: number; y: number }; done: () => void }
/** `returnTo`: what had focus before the right-click, where focus goes back when the menu or what it opened closes. */
interface MenuState { at: { x: number; y: number }; copy: string; start: CursorStart; returnTo: HTMLElement | null }

/**
 * A modal app menu (a Radix dropdown such as the persona menu) traps focus and turns the page's pointer events off, so
 * the assistant's own menu or composer could not be clicked or typed into beside it: it is closed first, as a
 * right-click outside it would close it (a right-click, so Radix leaves focus where the assistant puts it).
 */
function closeAppMenu(): void {
  if (![...document.querySelectorAll("[role=menu][data-state=open]")].some((m) => !m.closest("[data-assist-ui]"))) return;
  try { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2, pointerType: "mouse" })); } catch { /* old engine */ }
}

/** Focus is in a field of the page (the person is typing there), not in the assistant's own. */
const typingOnPage = (): boolean => {
  const a = document.activeElement;
  return a instanceof HTMLElement && !a.closest("[data-assist-ui]") && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
};

/** Focus is on nothing (the page body) or on one of the assistant's own surfaces, so closing them may move it back. */
const focusIsOurs = (): boolean => {
  const a = document.activeElement;
  return !a || a === document.body || !!a.closest("[data-assist-ui]");
};

/** The focused element worth returning to (not the page body, not the assistant's own surfaces). */
const focusedNow = (): HTMLElement | null => {
  const a = document.activeElement;
  return a instanceof HTMLElement && a !== document.body && !a.closest("[data-assist-ui]") ? a : null;
};

export function CursorAssistant({ pathname }: { pathname: string }) {
  const router = useRouter();
  const tour = useTour();
  const agentPanel = useAgent();
  const iconOn = useAssistIcon();
  const voiceOn = useAssistVoice();
  const docked = useMedia("(hover: none) and (pointer: coarse)");
  const sheet = useMedia("(max-width: 767px)");
  const host = useLayerHost();

  const [phase, setPhase] = useState<"idle" | "composer" | "card">("idle");
  const [at, setAt] = useState<{ x: number; y: number }>({ x: 120, y: 120 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [about, setAbout] = useState<EntityRef | null>(null);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<"idle" | "listening" | "transcribing">("idle");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [pointer, setPointer] = useState<Pointing | null>(null);
  const [walk, setWalk] = useState<WalkStepEffect[] | null>(null);
  // Each walkthrough is its own player (its key): a second one in the same run starts at its step 1 with a fresh
  // target lookup, never at the first one's step under the old ring.
  const [walkKey, setWalkKey] = useState(0);
  const [speech, setSpeech] = useState<string | null>(null);

  const startRef = useRef<CursorStart>({ under: null, selection: null, focus: null });
  const registry = useRef<Map<number, Registered>>(new Map());
  const ctrl = useRef(new AbortController());
  const seq = useRef(0);
  const stops = useRef<(() => void)[]>([]);
  const handled = useRef(new Set<string>());
  const played = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const listening = useRef<Listening | null>(null);
  const speakCtrl = useRef<AbortController | null>(null);
  const returnFocus = useRef<Element | null>(null);
  const detector = useRef(createRightClickDetector());
  const pointKey = useRef(0);
  /**
   * How the assistant last left the page (its route, and whether a layer was open): as it was when the question was
   * asked, or where its own last effect took it. The closing show compares the page now with this (mayShowNow).
   */
  const leftAt = useRef({ route: "", layer: false });
  const routerRef = useRef(router);
  routerRef.current = router;
  const exRef = useRef(exchange);
  exRef.current = exchange;
  const atRef = useRef(at);
  atRef.current = at;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  // ---- feeders: the pointer and hover trail, the interaction trail ------------------------------------------------
  useEffect(() => startCursorTracking(() => `${normalizePath(window.location.pathname)}${window.location.search}`), []);
  useEffect(() => startTrail(), []);
  useEffect(() => { syncTrail(); setPointer(null); }, [pathname]);

  /** The menu closes (Escape, a click outside, Copy) and focus goes back to where it was before the right-click. */
  const closeMenu = useCallback(() => {
    const back = menuRef.current?.returnTo ?? null;
    setMenu(null);
    if (back?.isConnected && focusIsOurs()) back.focus({ preventScroll: true });
  }, []);
  const addNote = useCallback((t: string) => setNotes((n) => (n.includes(t) ? n : [...n, t])), []);

  const stopWatching = () => { for (const s of stops.current.splice(0)) s(); };

  /** Ends everything the assistant has open: effects in flight, listening, speech, the pointer, the card, the menu. */
  const closeAll = useCallback((restore = true) => {
    ctrl.current.abort();
    ctrl.current = new AbortController();
    stopWatching();
    listening.current?.cancel();
    listening.current = null;
    speakCtrl.current?.abort();
    stopSpeaking();
    seq.current++;
    // An assist run still working is interrupted; a handoff's chat run keeps going (the Agent page shows it).
    const e = exRef.current;
    if (e?.assistId && !e.chatId && !ended(e.assist?.run?.status)) void client.post("/v1/agent/runs/:id/cancel", { params: { id: e.assistId } }).catch(() => undefined);
    setExchange(null);
    const menuBack = menuRef.current?.returnTo ?? null;
    setPhase("idle"); setMenu(null); setPointer(null); setWalk(null); setNotes([]); setVoice("idle"); setVoiceNote(null); setSpeech(null); setText("");
    const back = returnFocus.current ?? menuBack;
    returnFocus.current = null;
    // Only from the assistant's own surfaces (or nowhere): a field the person moved to while the card was open keeps it.
    if (restore && back instanceof HTMLElement && back.isConnected && focusIsOurs()) back.focus({ preventScroll: true });
  }, []);

  useEffect(() => { if (tour.active) closeAll(false); }, [tour.active, closeAll]);
  // Leaving the app shell (Back to the marketing page) ends everything: watches, the microphone, speech, effects, and
  // an assist run still working. Nothing the assistant started outlives it.
  useEffect(() => () => closeAll(false), [closeAll]);

  const routeNow = () => `${normalizePath(window.location.pathname)}${window.location.search}`;

  /** `returnTo`: where focus goes when the composer or its card closes (from the menu: what had focus before the right-click). */
  const openComposer = useCallback((point: { x: number; y: number }, start: CursorStart, opts: { listen?: boolean; returnTo?: HTMLElement | null } = {}) => {
    const focus = opts.returnTo !== undefined ? opts.returnTo : focusedNow();
    closeAppMenu();
    closeAll(false);
    returnFocus.current = focus;
    startRef.current = start;
    setAt(point);
    setAbout(start.under);
    setPhase("composer");
    if (opts.listen) startListening();
  }, [closeAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- effects ---------------------------------------------------------------------------------------------------
  const pointerFrom = () => { const p = lastPointer(); return p ? { x: p.x + 18, y: p.y + 22 } : { ...atRef.current }; };
  /**
   * The room the bottom sheet takes on a phone, at its largest, so a target is brought into view above it: an effect
   * plays while the card still says Working, and the answer that follows grows the sheet over what was ringed.
   */
  const sheetRoom = () => (sheetRef.current ? sheetReserve(window.innerHeight) : 0);
  /**
   * An effect's world, fixed when the effect is queued: the run's signal and its screen map registry. Once that run is
   * dismissed (Escape, the close button) or a new question starts, its signal is aborted, so a queued or running effect
   * moves, points, opens and notes nothing more, and never resolves its @n against another page's map.
   */
  const env = (signal: AbortSignal, reg: Map<number, Registered>): EffectEnv => ({
    here: routeNow,
    push: (href) => { if (!signal.aborted) routerRef.current.push(href); },
    registry: reg,
    point: (el, label) => (signal.aborted ? Promise.resolve() : new Promise<void>((resolve) => {
      const done = () => resolve();
      setPointer({ key: ++pointKey.current, target: el, label, from: pointerFrom(), done });
      // The glide is 420 ms; a pointer that never reports arriving (a hidden tab) does not hold the queue.
      setTimeout(done, 1_500);
      signal.addEventListener("abort", done, { once: true });
    })),
    note: (t) => { if (!signal.aborted) addNote(t); },
    walk: (steps) => { if (!signal.aborted) { setWalkKey((k) => k + 1); setWalk(steps); } },
    signal,
    sheetRoom,
  });
  /** Queues an effect with the run's signal and registry as they are now; it is skipped if that run ended by then. */
  const enqueue = (key: string, run: (e: EffectEnv) => Promise<void>) => {
    if (played.current.has(key)) return;
    played.current.add(key);
    const e = env(ctrl.current.signal, registry.current);
    queue.current = queue.current.then(() => (e.signal.aborted ? undefined : run(e))).catch(() => undefined);
  };
  const play = (runId: string, w: RunWatch) => {
    for (const p of playableEffects(w.steps, isTerminal(w.run?.status))) {
      enqueue(`${runId}:${p.n}`, async (e) => {
        await applyEffect(p.effect, e);
        if (e.signal.aborted) return;
        leftAt.current = { route: routeNow(), layer: !!openLayer() };
        const line = effectTrailLabel(p.effect, !!w.run?.tainted);
        if (line) pushTrail("effect", line);
      });
    }
    if (refusedChange(w.steps)) addNote(ASSIST_COPY.refused);
  };

  /** A chip's show, checked again here against the manifest (a global intent, a route in the nav registry). */
  const playChip = (chip: ClosingChip) => {
    const c = checkIntent(chip.intent, chip.params, []);
    if (!c.ok || c.def.scope !== "global") return;
    const r = c.route ? checkRoute(c.route, { hosted: HOSTED }) : null;
    if (r && !r.ok) return;
    const anchor = chip.anchor && Object.hasOwn(ASSIST_ANCHORS, chip.anchor) ? chip.anchor : null;
    const selectors = anchor ? fillSelectors(ASSIST_ANCHORS[anchor]!.selectors, c.params) : [];
    enqueue(`chip:${chip.id}:${++pointKey.current}`, (e) => applyEffect({ effect: "show", via: "intent", intent: c.def.id, params: c.params, route: r ? r.route : null, anchor, selectors, label: chip.label.slice(0, 40) }, e));
  };

  const speakAnswer = useCallback(async (answer: string | null | undefined) => {
    if (!answer) return;
    speakCtrl.current?.abort();
    const c = new AbortController();
    speakCtrl.current = c;
    setSpeech(null);
    const used = await speak(answer, { signal: c.signal, onProgress: (p) => setSpeech(ASSIST_COPY.voiceDownloading(Math.min(100, Math.round((p.loaded / Math.max(1, p.total)) * 100)))) });
    if (!c.signal.aborted) setSpeech(used ? null : ASSIST_COPY.voiceUnavailable);
  }, []);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;

  /**
   * A run is over: the closing show code built (a proposal's card ringed in the Inbox), and the answer spoken when on.
   * The show moves the page only while the person is still where they asked and doing nothing else (mayShowNow);
   * otherwise it stays a "Show me" chip on the card, theirs to press.
   */
  const finish = (t: AssistTrace) => {
    const prop = t.closing?.proposals[0];
    const chip = prop ? t.closing?.chips.find((c) => c.id === prop && c.intent === "approval.card") : undefined;
    if (chip && mayShowNow({ askedFrom: leftAt.current.route, here: routeNow(), typing: typingOnPage(), layerNow: !!openLayer(), layerThen: leftAt.current.layer })) playChip(chip);
    if (voiceRef.current && t.run.summary && !t.closing?.choose) void speakAnswer(t.run.summary);
  };

  /** The trace once more (its last step may land a moment after the run row says it ended). */
  const readTrace = async (runId: string): Promise<AssistTrace | null> => {
    try {
      const res = await rawFetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/trace`, { headers: { accept: "application/json", "x-weft-principal": getPrincipal() } });
      return res.ok ? ((await res.json()) as AssistTrace) : null;
    } catch { return null; }
  };

  const watchChat = (exId: number, chatId: string) => {
    setExchange((e) => (e && e.id === exId ? { ...e, chatId } : e));
    stops.current.push(watchRun(chatId, (w) => {
      if (seq.current !== exId) return;
      setExchange((e) => (e && e.id === exId ? { ...e, chat: w } : e));
      const t = traceOf(w);
      if (t && ended(t.run.status) && !handled.current.has(chatId)) {
        handled.current.add(chatId);
        invalidate();
        finish(t);
      }
    }));
  };

  const watchAssist = (exId: number, runId: string) => {
    stops.current.push(watchRun(runId, (w) => {
      if (seq.current !== exId) return;
      setExchange((e) => (e && e.id === exId ? { ...e, assist: w } : e));
      play(runId, w);
      const t = traceOf(w);
      if (!t || !isTerminal(t.run.status) || handled.current.has(runId)) return;
      handled.current.add(runId);
      void (async () => {
        let tr: AssistTrace | null = t;
        // HANDED_OFF names the chat run on its terminal step, which may not be in this read yet.
        for (let i = 0; tr && tr.run.terminalReason === "HANDED_OFF" && !tr.handoff?.to && i < 6; i++) {
          await new Promise((r) => setTimeout(r, 300));
          tr = (await readTrace(runId)) ?? tr;
        }
        if (seq.current !== exId || !tr) return;
        if (tr !== t) { setExchange((e) => (e && e.id === exId && e.assist ? { ...e, assist: { ...e.assist, trace: tr } } : e)); play(runId, { ...w, steps: tr.steps, run: tr.run }); }
        if (tr.handoff?.to) watchChat(exId, tr.handoff.to);
        else finish(tr);
      })();
    }));
  };

  /** Asks: the page as it is now, sent as an assist run in the thread (a new one per question, the same for a choice). */
  const ask = async (question: string, opts: { threadId?: string; under?: EntityRef | null } = {}) => {
    const q = question.trim().slice(0, 4000);
    if (!q) return;
    // Still inside the person's gesture (the send, a choice): a spoken answer may then play when it arrives.
    if (voiceRef.current) primeVoice();
    ctrl.current.abort();
    ctrl.current = new AbortController();
    stopWatching();
    listening.current?.cancel();
    listening.current = null;
    speakCtrl.current?.abort();
    stopSpeaking();
    setPointer(null); setWalk(null); setNotes([]); setVoice("idle"); setText(""); setSpeech(null);
    const exId = ++seq.current;
    const threadId = opts.threadId ?? newThreadId();
    setExchange({ id: exId, question: q, threadId, assistId: null, assist: null, chatId: null, chat: null, error: null, stopped: false });
    leftAt.current = { route: routeNow(), layer: !!openLayer() };
    setPhase("card");
    try {
      const path = normalizePath(window.location.pathname);
      const search = window.location.search;
      const read = readScreen(`${path}${search}`, { intents: offeredIntents(path) });
      registry.current = read.registry;
      const start = startRef.current;
      const cursor = buildCursor({ ...start, under: opts.under !== undefined ? opts.under : start.under }, read.registry, path, search);
      const req = fitAssistRequest({ text: q, pageContext: path, threadId, recipe: "assist", assist: { screen: read.screen, cursor, records: summarizeRecords(mountedQueries()), trail: trailEvents() } });
      if (!req) throw new Error(ASSIST_COPY.error);
      pushTrail("ask", `Asked: ${q}`);
      const res = (await client.post("/v1/agent/runs", { body: req })) as unknown as AssistRunAccepted;
      // Dismissed (Escape, the close button, a new question) before the run was accepted: closeAll had no id to
      // cancel then, so it is cancelled now; a request the person dropped never goes on, or hands off, unseen.
      if (seq.current !== exId) { void client.post("/v1/agent/runs/:id/cancel", { params: { id: res.runId } }).catch(() => undefined); return; }
      setExchange((e) => (e && e.id === exId ? { ...e, assistId: res.runId, threadId: res.threadId || threadId } : e));
      watchAssist(exId, res.runId);
    } catch (e) {
      if (seq.current === exId) setExchange((x) => (x && x.id === exId ? { ...x, error: errorText(e) } : x));
    }
  };

  const startListening = () => {
    const mode = browserVoiceInMode();
    setVoiceNote(null);
    if (mode === "none") { setVoiceNote(VOICE_COPY.none); return; }
    listening.current?.cancel();
    if (voiceRef.current) primeVoice();
    // Each session's handlers act only while it is the current one: a late word from one that was cancelled (a
    // denial after Escape) never clears or notes over the session that replaced it.
    let me: Listening | null = null;
    const mine = () => listening.current === me;
    me = listen({
      onPartial: (t) => { if (mine()) setText(t); },
      onFinal: (t) => { if (!mine()) return; listening.current = null; void ask(t); },
      onError: (m) => { if (!mine()) return; listening.current = null; setVoice("idle"); setVoiceNote(m); },
      onState: (s) => { if (mine()) setVoice(s); },
    }, mode);
    listening.current = me;
  };

  // ---- the hotkey, Escape and the right-click menu ---------------------------------------------------------------
  const live = useRef({ phase, menu, walk, pointer, tourActive: tour.active });
  live.current = { phase, menu, walk, pointer, tourActive: tour.active };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = live.current;
      // The J key wherever the layout puts its letter (e.code): a Russian, Greek or Hebrew layout reports another one.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyJ" || e.key.toLowerCase() === "j")) {
        if (l.tourActive) return;
        e.preventDefault();
        // Pressing it again interrupts whatever is open (research/cursor-assistant.md 4.1).
        if (l.phase !== "idle" || l.walk || l.menu) { closeAll(); return; }
        // From the keyboard: at the focused control and about its record when focus moved there after the pointer
        // last did, else at the pointer (context.ts keyboardStart).
        const k = keyboardStart(routeNow());
        openComposer(k.at ?? { x: Math.max(16, window.innerWidth / 2 - 180), y: 96 }, k.start);
        return;
      }
      // Escape is the assistant's while it has anything open: the window's capture phase runs before a drawer's own
      // Escape listener (Radix listens on the document), so one Escape dismisses the card and leaves the drawer it
      // showed open; the next one closes the drawer.
      if (e.key === "Escape" && (l.phase !== "idle" || l.walk || l.menu || l.pointer)) {
        e.preventDefault();
        e.stopPropagation();
        // The menu alone goes first: an answer, a walkthrough or a run behind it stays until the next Escape.
        if (l.menu) closeMenu();
        else closeAll();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [closeAll, closeMenu, openComposer]);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (live.current.tourActive) return;
      const t = e.target instanceof Element ? e.target : null;
      // Fields keep the browser's menu (paste, spelling); so do the assistant's own surfaces, except its menu, where
      // the second press of a double right-click lands.
      if (!t || t.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
      if (t.closest("[data-assist-ui]") && !t.closest(`[data-testid="${ASSIST_TID.menu}"]`)) return;
      e.preventDefault();
      // A menu opened from the keyboard may carry no pointer position: it opens at the element instead.
      const r = t.getBoundingClientRect();
      const point = Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? { x: e.clientX, y: e.clientY } : { x: r.left + 8, y: r.top + 8 };
      if (detector.current.press({ t: performance.now(), ...point }) === "double") {
        // The second press lands on the menu, which holds focus by then: focus goes back to what had it before the first.
        const m = live.current.menu;
        openComposer(point, m?.start ?? captureStart(point, routeNow()), { listen: true, returnTo: m ? m.returnTo : focusedNow() });
        return;
      }
      const copy = window.getSelection?.()?.toString() ?? "";
      const start = captureStart(point, routeNow());
      // Focus to return to: what had it before (the answer card too, which stays open), unless that is the menu this
      // one replaces (then what that menu was to return to).
      const a = document.activeElement;
      const returnTo = a instanceof HTMLElement && a !== document.body && !a.closest(`[data-testid="${ASSIST_TID.menu}"]`) ? a : live.current.menu?.returnTo ?? null;
      // Opening the menu is not a choice: an answer, its approval card and chips, a walkthrough or a run still
      // working all stay. Only Ask about this (or a double right-click) starts over; Copy leaves them be.
      closeAppMenu();
      setMenu({ at: point, copy, start, returnTo });
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, [closeAll, openComposer]);

  // ---- render ----------------------------------------------------------------------------------------------------
  // The ringed target, followed each frame: after a scroll or a resize the card is placed clear of where it is now.
  const avoid: Rect | null = useTrackedRect(pointer?.target ?? null);
  const assistT = traceOf(exchange?.assist ?? null);
  const chatT = traceOf(exchange?.chat ?? null);
  const handedOff = !!exchange?.chatId;
  const finalT = handedOff ? (chatT && ended(chatT.run.status) ? chatT : null) : assistT && isTerminal(assistT.run.status) && assistT.run.terminalReason !== "HANDED_OFF" ? assistT : null;
  const hideCard = !!walk && !!finalT;

  return (
    <InLayer host={host}>
      {/* Docked on a phone, the icon would sit over the right-hand button of what fills the screen there (the agent's
          Send, a drawer's Submit): it steps aside whenever one is open. */}
      <CursorIcon hidden={iconHidden({ on: iconOn, tour: tour.active, busy: phase !== "idle" || !!walk || !!menu, docked, agentComposer: pathname === "/app/agent" || agentPanel.open, layer: host !== null })} docked={docked}
        onOpen={(p, el) => openComposer(p, captureStart(lastPointer(), routeNow()), docked ? { returnTo: el } : {})} />
      {menu ? (
        <WeftMenu at={menu.at} canCopy={!!menu.copy.trim()}
          onCopy={() => { const c = menu.copy; closeMenu(); void navigator.clipboard?.writeText(c).catch(() => undefined); }}
          onAsk={() => openComposer(menu.at, menu.start, { returnTo: menu.returnTo })}
          onClose={closeMenu} />
      ) : null}
      {phase === "composer" ? (
        <Composer at={at} sheet={sheet} about={about} onClearAbout={() => { setAbout(null); startRef.current = { ...startRef.current, under: null }; }}
          text={text} setText={setText} voice={voice} voiceNote={voiceNote}
          onSubmit={() => void ask(text)} onClose={() => closeAll()}
          onMic={() => (listening.current ? listening.current.stop() : startListening())} />
      ) : null}
      {phase === "card" && exchange && !hideCard ? (
        <FloatingCard at={at} avoid={avoid} sheet={sheet} testId={ASSIST_TID.popover} label={ASSIST_COPY.menuLabel} live focusKey={exchange.id}>
          <div className="flex items-center gap-1.5 border-b border-[var(--app-border)] px-3 py-2">
            <Sparkles className="size-3.5 shrink-0 text-[var(--accent-9)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-1 text-gray-11" title={exchange.question}>{exchange.question}</span>
            <button type="button" data-testid={ASSIST_TID.voiceOut} aria-pressed={voiceOn} aria-label={voiceOn ? ASSIST_COPY.voiceOn : ASSIST_COPY.voiceOff} title={voiceOn ? ASSIST_COPY.voiceOn : ASSIST_COPY.voiceOff}
              onClick={() => { const on = !voiceOn; setAssistPref("voice", on); if (on) primeVoice(); if (on && finalT?.run.summary) void speakAnswer(finalT.run.summary); else { speakCtrl.current?.abort(); stopSpeaking(); setSpeech(null); } }}
              className={cn("grid size-6 place-items-center rounded-md text-gray-10 hover:bg-gray-3 hover:text-foreground", voiceOn && "text-[var(--accent-11)]")}>
              {voiceOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
            </button>
            <button type="button" data-testid={ASSIST_TID.close} aria-label={ASSIST_COPY.close} onClick={() => closeAll()} className="grid size-6 place-items-center rounded-md text-gray-10 hover:bg-gray-3 hover:text-foreground"><X className="size-3.5" /></button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2.5">
            {exchange.error ? <p role="alert" className="text-1 text-red-11">{exchange.error || ASSIST_COPY.error}</p> : null}
            {handedOff ? (
              <Progress watch={exchange.chat} stopped={exchange.stopped} threadId={exchange.threadId}
                onStop={() => { const id = exchange.chatId!; setExchange((e) => (e ? { ...e, stopped: true } : e)); void client.post("/v1/agent/runs/:id/cancel", { params: { id } }).catch(() => undefined); }} />
            ) : null}
            {finalT ? <Answer trace={finalT} threadId={exchange.threadId} handedOff={handedOff} onChip={playChip}
              onChoose={(o) => void ask(choiceText(o), { threadId: exchange.threadId, under: { entity: o.id, kind: PREFIX_KIND[o.id.slice(0, 4)] ?? "record", label: o.label.slice(0, 120) } })} />
              : !handedOff && !exchange.error ? <div data-testid={ASSIST_TID.status} className="text-[13px]"><ShimmerText>{ASSIST_COPY.working}</ShimmerText></div> : null}
            {notes.length ? <ul role="status" className="flex flex-col gap-1">{notes.map((n) => <li key={n} data-testid="assist-note" className="text-1 text-amber-11">{n}</li>)}</ul> : null}
            {speech ? <p data-testid={ASSIST_TID.voiceProgress} role="status" className="text-1 text-gray-10">{speech}</p> : null}
          </div>
        </FloatingCard>
      ) : null}
      {pointer ? <AssistPointer key={pointer.key} target={pointer.target} label={pointer.label} from={pointer.from} onArrived={pointer.done} /> : null}
      {walk ? <WalkPlayer key={walkKey} steps={walk} registry={registry.current} here={routeNow} push={(h) => router.push(h)} sheet={sheet} start={at} pathname={pathname} onExit={() => closeAll()} /> : null}
    </InLayer>
  );
}

function Composer({ at, sheet, about, onClearAbout, text, setText, voice, voiceNote, onSubmit, onClose, onMic }: {
  at: { x: number; y: number }; sheet: boolean; about: EntityRef | null; onClearAbout: () => void; text: string; setText: (t: string) => void;
  voice: "idle" | "listening" | "transcribing"; voiceNote: string | null; onSubmit: () => void; onClose: () => void; onMic: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  // After the card is placed (it renders hidden until measured, and a hidden field cannot take focus). A modal app
  // menu that was open as it opened (closeAppMenu) holds focus inside itself until it is gone: focus comes back here
  // then, unless the person already moved it somewhere of their own.
  useEffect(() => {
    const r = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    const again = () => { const a = document.activeElement; if (input.current && (!a || a === document.body || a.closest("[role=menu]"))) input.current.focus({ preventScroll: true }); };
    const t = [setTimeout(again, 200), setTimeout(again, 450)];
    return () => { cancelAnimationFrame(r); t.forEach(clearTimeout); };
  }, []);
  const micMode = browserVoiceInMode();
  const aboutLabel = about ? about.label || about.kind.replaceAll("_", " ") : null;
  return (
    <FloatingCard at={at} avoid={null} sheet={sheet} testId={ASSIST_TID.composer} label={ASSIST_COPY.placeholder}>
      <form className="flex flex-col gap-1.5 p-2" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        {aboutLabel ? (
          <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-gray-3 px-1.5 py-0.5 text-1 text-gray-11" data-entity={about!.entity}>
            <span className="truncate">{ASSIST_COPY.aboutThis(aboutLabel)}</span>
            <button type="button" aria-label={ASSIST_COPY.clearAbout(aboutLabel)} title={ASSIST_COPY.clearAbout(aboutLabel)} onClick={onClearAbout} className="text-gray-10 hover:text-foreground"><X className="size-3" /></button>
          </span>
        ) : null}
        <div className="flex items-center gap-1.5">
          <input ref={input} data-testid={ASSIST_TID.input} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
            placeholder={voice === "listening" ? ASSIST_COPY.listening : ASSIST_COPY.placeholder} aria-label={ASSIST_COPY.placeholder}
            className="min-w-0 flex-1 bg-transparent px-1 py-1 text-2 outline-none placeholder:text-gray-9" />
          {micMode !== "none" ? (
            <button type="button" data-testid={ASSIST_TID.mic} data-mode={micMode} aria-label={voice === "listening" ? ASSIST_COPY.stop : ASSIST_COPY.mic} aria-pressed={voice === "listening"} onClick={onMic}
              className={cn("grid size-7 shrink-0 place-items-center rounded-full text-gray-11 hover:bg-gray-3", voice === "listening" && "bg-red-3 text-red-11")}>
              {voice === "listening" ? <Square className="size-3" /> : <Mic className="size-3.5" />}
            </button>
          ) : null}
          <button type="submit" data-testid={ASSIST_TID.send} aria-label={ASSIST_COPY.send} disabled={!text.trim()} className="grid size-7 shrink-0 place-items-center rounded-full bg-gray-12 text-white disabled:opacity-40"><ArrowUp className="size-3.5" /></button>
        </div>
        {voice !== "idle" ? <p data-testid={ASSIST_TID.transcript} aria-live="polite" className="px-1 text-1 text-gray-10">{voice === "transcribing" ? ASSIST_COPY.transcribing : text || ASSIST_COPY.listening}</p> : null}
        {voiceNote ? <p role="status" className="px-1 text-1 text-amber-11">{voiceNote}</p> : null}
      </form>
    </FloatingCard>
  );
}

const TONE_ICON: Record<string, ReactNode> = {
  ok: <Check className="mt-0.5 size-3.5 shrink-0 text-gray-9" />,
  pending: <Clock className="mt-0.5 size-3.5 shrink-0 text-amber-11" />,
  bad: <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-red-11" />,
};
const toneOf = (o: RunStepRow["outcome"]) => (!o || o === "ok" ? "ok" : o.startsWith("pending:") ? "pending" : "bad");

/** The handoff's progress card: the chat run's steps in plain words while it works, Stop, and Open in Agent. */
function Progress({ watch, stopped, threadId, onStop }: { watch: RunWatch | null; stopped: boolean; threadId: string; onStop: () => void }) {
  const status = watch?.run?.status;
  const working = !ended(status);
  const lines = progressSteps(watch?.steps ?? [], stepSummary);
  // Stop goes away once pressed (or once the run ends): focus that was on it moves to Open in Agent, not the page's top.
  const stopFocused = useRef(false);
  const open = useRef<HTMLAnchorElement | null>(null);
  const showStop = working && !stopped;
  useEffect(() => {
    if (showStop || !stopFocused.current) return;
    stopFocused.current = false;
    const a = document.activeElement;
    if (!a || a === document.body) open.current?.focus({ preventScroll: true });
  }, [showStop]);
  return (
    <section data-testid={ASSIST_TID.progress} data-status={status ?? "starting"} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-gray-12">
        {working && !stopped ? <ShimmerText>{ASSIST_COPY.handedOff}</ShimmerText> : <span>{stopped ? ASSIST_COPY.handedOff : ASSIST_COPY.handedOffDone}</span>}
      </div>
      {lines.length ? (
        <ul className="flex flex-col gap-1">
          {lines.map((l) => <li key={l.n} data-testid={ASSIST_TID.step} data-outcome={l.outcome ?? ""} className="flex min-w-0 items-start gap-1.5 text-1 leading-5 text-gray-11">{TONE_ICON[toneOf(l.outcome)]}<span className="min-w-0 break-words">{l.text}</span></li>)}
        </ul>
      ) : null}
      {stopped ? <p role="status" className="text-1 text-gray-11">{ASSIST_COPY.stopped}</p> : null}
      <div className="flex items-center gap-1.5">
        {showStop ? (
          <button type="button" data-testid={ASSIST_TID.stop} onClick={onStop} onFocus={() => { stopFocused.current = true; }} onBlur={() => { stopFocused.current = false; }} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-1 text-gray-11 shadow-[var(--shadow-border)] hover:bg-gray-2"><Square className="size-3" aria-hidden /> {ASSIST_COPY.stop}</button>
        ) : null}
        <Link ref={open} href={agentHref(threadId)} onClick={(e) => followInPlace(e, agentHref(threadId), viewPatch(agentHref(threadId)))} data-testid={ASSIST_TID.openInAgent} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-1 text-gray-11 hover:bg-gray-2 hover:text-foreground">{ASSIST_COPY.openInAgent} <ExternalLink className="size-3" aria-hidden /></Link>
      </div>
    </section>
  );
}

/** A finished run's answer: the grounded text (clipped), its approval cards, the closing chips or the choice. */
function Answer({ trace, threadId, handedOff, onChip, onChoose }: { trace: AssistTrace; threadId: string; handedOff: boolean; onChip: (c: ClosingChip) => void; onChoose: (o: ClosingChip) => void }) {
  const [decided, setDecided] = useState<Record<string, ProposalStatus>>({});
  const run = trace.run;
  const closing = trace.closing ?? null;
  const summary = run.status === "cancelled" ? ASSIST_COPY.stopped : run.summary ?? (run.status === "done" ? "" : ASSIST_COPY.error);
  const { text, clipped } = clipAnswer(summary);
  const proposalOf = (id: string) => trace.proposals?.find((p) => p.id === id);
  const chips = closing?.chips ?? [];
  return (
    <div className="flex flex-col gap-2.5" data-run-id={run.id} data-status={run.status}>
      {run.tainted ? <p className="flex items-start gap-1.5 rounded-lg bg-amber-3 px-2 py-1.5 text-1 text-amber-11"><ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden /><span title={run.taintedBy ?? undefined}>This answer read untrusted content: {taintText(run.taintedBy)}.</span></p> : null}
      {text ? <AnswerView text={text} runId={run.id} testId={ASSIST_TID.answer} /> : null}
      {closing?.choose ? (
        <div className="flex flex-col gap-1.5" role="group" aria-label={ASSIST_COPY.choose}>
          <span className="text-1 text-gray-10">{ASSIST_COPY.choose}</span>
          <div className="flex flex-wrap gap-1.5">
            {closing.choose.options.map((o) => <button key={o.id} type="button" data-testid={ASSIST_TID.choice} data-entity={o.id} onClick={() => onChoose(o)} className="rounded-full px-2.5 py-1 text-1 text-gray-12 shadow-[var(--shadow-border)] hover:bg-gray-2">{o.label}</button>)}
          </div>
        </div>
      ) : null}
      {(trace.cards ?? []).map((c) => (
        <div key={c.proposalId} data-testid={ASSIST_TID.card}>
          <ApprovalCard compact card={c} status={decided[c.proposalId] ?? proposalOf(c.proposalId)?.status} taintedBy={cardTaint(trace, c.proposalId)} known={!!trace.proposals}
            onDecided={(r) => { if (r.ok) setDecided((d) => ({ ...d, [c.proposalId]: r.proposal.status })); invalidate(); }} />
        </div>
      ))}
      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => <button key={c.id} type="button" data-testid={ASSIST_TID.chip} data-entity={c.id} onClick={() => onChip(c)} className="rounded-full bg-gray-3 px-2.5 py-1 text-1 text-gray-12 hover:bg-gray-4">{ASSIST_COPY.showMe(chipLabel(c))}</button>)}
        </div>
      ) : null}
      {/* A handoff's progress card holds its own Open in Agent; a clipped answer's full text is there too. */}
      {handedOff ? null : (
        <Link href={agentHref(threadId)} onClick={(e) => followInPlace(e, agentHref(threadId), viewPatch(agentHref(threadId)))} data-testid={clipped ? ASSIST_TID.openInAgent : ASSIST_TID.continue} className="inline-flex w-fit items-center gap-1 text-1 text-gray-10 hover:text-foreground">
          {clipped ? ASSIST_COPY.openInAgent : ASSIST_COPY.continueInAgent} <ExternalLink className="size-3" aria-hidden />
        </Link>
      )}
    </div>
  );
}
