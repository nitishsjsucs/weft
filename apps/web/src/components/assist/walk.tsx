"use client";
// A walkthrough (ui.steps, at most six steps) played on the tour's pieces: each step opens its route when it has one,
// waits for its target the way the tour does (the anchor's selectors, about 3 s, then visible and not covered), rings
// it with the tour's ring and shows the step's words in a small card with Back and Next. It only points: no step
// presses, types or opens anything, and the executor already refused any step on a control that changes data. A
// target that never appears says so and waits; another element is never guessed.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { ASSIST_TID, stepRefusal, type WalkStepEffect } from "../../../../../packages/contracts/src/ext/assist";
import { HOSTED } from "@/lib/hosted/flags";
import type { Rect } from "../tour/geometry";
import { sleep } from "../tour/dom";
import { TourRing } from "../tour/tour-ring";
import { ASSIST_COPY } from "./copy";
import { actionable, entityOfEl, hrefOf, kindOf, labelOf, MUTATING_MARK, resolveRegistered, type Registered } from "./dom";
import { bringIntoView, goTo, TARGET_WAIT_MS, waitTarget } from "./effects";
import { sheetReserve } from "./surface-core";
import { FloatingCard, useTrackedRect } from "./visuals";

/** The step a walkthrough shows: `i` kept inside its steps (never past its last, whatever the player held before). */
export function walkIndex(i: number, n: number): number {
  return Math.max(0, Math.min(i, n - 1));
}

/**
 * The page step `k` opens as it is entered: its own route, else the page it was on before (Back from a later step's
 * page returns there), else, before any step has moved, the page the walkthrough started on. Null for a step with no
 * route that has not been entered yet after a move: it waits on the page the person reached.
 */
export function stepPage(steps: readonly Pick<WalkStepEffect, "route">[], k: number, shownOn: ReadonlyMap<number, string>, startedOn: string): string | null {
  return steps[k]?.route ?? shownOn.get(k) ?? (steps.slice(0, k).every((s) => !s.route) ? startedOn : null);
}

export function WalkPlayer({ steps, registry, here, push, sheet, start, pathname, onExit }: {
  steps: WalkStepEffect[]; registry: Map<number, Registered>; here: () => string; push: (href: string) => void; sheet: boolean; pathname: string;
  start: { x: number; y: number }; onExit: () => void;
}) {
  const [i, setI] = useState(0);
  // The target with the step it was found for: a step just entered never shows the ring (or "found") of the one before.
  const [found, setFound] = useState<{ k: number; el: HTMLElement } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [refused, setRefused] = useState(false);
  // A step waiting for its part of the page looks again when the person moves to another page (following the step before).
  const [tries, setTries] = useState(0);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  useEffect(() => { if (waitingRef.current) setTries((t) => t + 1); }, [pathname]);
  const k = walkIndex(i, steps.length);
  const step = steps[k]!;
  const target = found?.k === k ? found.el : null;
  // Where each step was last looked for (found, or waiting for the person to get there), and where the walkthrough
  // started: a step with no route of its own is looked for there when it is entered again (Back).
  const shownOn = useRef(new Map<number, string>());
  const startedOn = useRef<string | null>(null);
  startedOn.current ??= here();
  const lookedAgain = useRef(tries);
  useEffect(() => {
    const ctrl = new AbortController();
    setFound(null);
    setWaiting(false);
    setRefused(false);
    // Looking again because the person moved (tries) never takes them back: only entering the step does. (Read from
    // tries, not from k, so React's second mount run in development still counts as entering.)
    const arriving = lookedAgain.current === tries;
    lookedAgain.current = tries;
    void (async () => {
      const page = arriving ? stepPage(steps, k, shownOn.current, startedOn.current!) : null;
      // A step's own route always opens (with its view state); the page it was on only when the person is elsewhere.
      const open = step.route ?? (page && page.split("?")[0] !== here().split("?")[0] ? page : null);
      if (open && !(await goTo(open, { here, push, signal: ctrl.signal }))) { if (!ctrl.signal.aborted) setWaiting(true); return; }
      let el: HTMLElement | null = null;
      // On a phone the walk card is a bottom sheet: each target is brought into view above it, never under it.
      const room = sheet ? sheetReserve(window.innerHeight) : 0;
      // A screen map number names the page the walkthrough started on; an anchor is looked up like a tour step.
      if (step.target.kind === "item") {
        el = resolveRegistered(registry.get(step.target.n));
        // The element found now is checked again like the server checked the map's: never a control a person presses.
        if (el && stepRefusal({ kind: kindOf(el), label: labelOf(el).label, testid: el.dataset.testid ?? null, anchor: registry.get(step.target.n)?.item.anchor ?? null, entity: entityOfEl(el, here())?.entity ?? null, href: hrefOf(el), mutating: !!el.closest(MUTATING_MARK) }, { hosted: HOSTED })) {
          if (!ctrl.signal.aborted) setRefused(true);
          return;
        }
        if (el) {
          await bringIntoView(el, room);
          // Checked again after the scroll, as a point is: a sticky header or an open layer may cover it there.
          if (!actionable(el)) { await sleep(150, ctrl.signal); if (!actionable(el)) el = null; }
        }
      } else {
        el = (await waitTarget(step.selectors, null, ctrl.signal, TARGET_WAIT_MS, room)).el;
        // An anchor's element the page marks as a control that changes data is never ringed either.
        if (el?.closest(MUTATING_MARK)) { if (!ctrl.signal.aborted) setRefused(true); return; }
      }
      if (ctrl.signal.aborted) return;
      shownOn.current.set(k, here());
      if (el) setFound({ k, el }); else setWaiting(true);
    })();
    return () => ctrl.abort();
  }, [k, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = k === steps.length - 1;
  // Followed each frame, so after a scroll or a resize the card stays clear of the ringed target.
  const box: Rect | null = useTrackedRect(target);
  const at = box ? { x: box.left, y: box.bottom } : start;
  return (
    <>
      {target ? <TourRing target={target} found secondary={[]} /> : null}
      {/* It takes focus when it appears and on each step (unless focus is already on its Back or Next), so its
          controls are the next Tab stops and a screen reader reads the step, the first one included. */}
      <FloatingCard at={at} avoid={box} sheet={sheet} testId={ASSIST_TID.walk} label={ASSIST_COPY.walkStep(k + 1, steps.length)} live focusKey={k}>
        <div className="flex flex-col gap-2 p-3" data-step={k + 1} data-found={target ? "true" : waiting ? "false" : "waiting"}>
          <div className="flex items-center gap-2">
            <span className="text-1 text-gray-10">{ASSIST_COPY.walkStep(k + 1, steps.length)}</span>
            <span className="flex-1" />
            <button type="button" onClick={onExit} aria-label={ASSIST_COPY.close} data-testid={ASSIST_TID.close} className="grid size-6 place-items-center rounded-md text-gray-10 hover:bg-gray-3 hover:text-foreground"><X className="size-3.5" /></button>
          </div>
          <p className="text-2 font-medium text-gray-12">{step.label}</p>
          <p className="text-[13px] leading-5 text-gray-11">{step.text}</p>
          {waiting ? <p role="status" className="text-1 text-amber-11">{ASSIST_COPY.walkWaiting}</p> : null}
          {refused ? <p role="status" className="text-1 text-amber-11">{ASSIST_COPY.walkRefused}</p> : null}
          <div className="flex items-center gap-1.5 pt-1">
            <button type="button" data-testid={ASSIST_TID.walkBack} disabled={k === 0} onClick={() => setI(Math.max(0, k - 1))}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-1 text-gray-11 shadow-[var(--shadow-border)] hover:bg-gray-2 disabled:opacity-50"><ArrowLeft className="size-3.5" aria-hidden /> {ASSIST_COPY.walkBack}</button>
            <span className="flex-1" />
            <button type="button" data-testid={ASSIST_TID.walkNext} onClick={() => (last ? onExit() : setI(k + 1))}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-gray-12 px-2.5 text-1 font-medium text-white hover:bg-gray-11">{last ? ASSIST_COPY.walkDone : <>{ASSIST_COPY.walkNext} <ArrowRight className="size-3.5" aria-hidden /></>}</button>
          </div>
        </div>
      </FloatingCard>
    </>
  );
}
