"use client";
// The tour card (owner: tour). Anchored steps use a Radix Popover with a virtual anchor on the target, so
// floating-ui's autoUpdate follows scroll and resize; centered steps (welcome, close) use a Radix Dialog over the
// app's bg-black/20 scrim; a missing target or a phone gets a fixed sheet. Styling follows PopoverContent and
// research/design.md: bg-card, rounded-xl, --shadow-modal, 13 px text, the madder accent for progress.
import { Dialog, Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Pause, Play, X } from "lucide-react";
import { Button, Kbd, ShimmerText } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TOUR_STEPS, type TourStep } from "./steps";
import { overlapArea, placeCard, sameRect, type Rect, type Side } from "./geometry";
import { appLayerRects, contentBounds, occluded, useFrameValue, visibleRect } from "./layout";

export type StatusTone = "working" | "waiting" | "done" | "error" | "muted";

export interface CardView {
  step: TourStep;
  index: number;
  body: string;
  ready: boolean;
  found: boolean;
  /** The step's own selector matched, or a fallback did. */
  match?: "primary" | "fallback" | null;
  target: HTMLElement | null;
  status: { text: string; tone: StatusTone } | null;
  note: string | null;
  nextEnabled: boolean;
  primary: { label: string; onClick: () => void; kbd?: boolean; testid?: string } | null;
  secondary: { label: string; onClick: () => void; testid?: string }[];
  link: { href: string; label: string } | null;
  offPage: boolean;
  /** Phone layout: dock the sheet at the top (agent steps) or the bottom. */
  sheet: "top" | "bottom" | null;
  /** Selectors for context the copy names (read every frame, as rows load late): the card keeps clear of them when it can. */
  avoid: string[];
  /** The secondary marks, which the card also keeps clear of. */
  marks: Element[];
}

export interface CardHandlers {
  onBack: () => void;
  onExit: () => void;
  onToggleAutoplay: () => void;
  /** Autoplay pauses while the pointer, or focus the person moved (not the title the tour focuses), is in the card. */
  onHover: (kind: "pointer" | "focus", inside: boolean) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
  bodyId: string;
  titleId: string;
  autoplay: boolean;
  desktop: boolean;
  /** Move focus to the title when the step is ready (off on steps that open an app popover). */
  focusTitle: boolean;
}

const TOTAL = TOUR_STEPS.length;

/** Sides to try, best first: beside the drawer or popover a docked step opens, into the main column for a target in the agent panel, else below. */
export function sideOrder(dock: "side" | undefined, inAgentPanel: boolean): Side[] {
  if (inAgentPanel) return ["left", "bottom", "top", "right"];
  return dock === "side" ? ["left", "right", "bottom", "top"] : ["bottom", "top", "left", "right"];
}

interface Scene { target: Rect | null; bounds: Rect; obstacles: Rect[]; avoid: Rect[]; inAgent: boolean }
const sameScene = (a: Scene | null, b: Scene | null): boolean =>
  a === b || (!!a && !!b && a.inAgent === b.inAgent && sameRect(a.target, b.target) && sameRect(a.bounds, b.bounds)
    && a.obstacles.length === b.obstacles.length && a.obstacles.every((r, i) => sameRect(r, b.obstacles[i]!))
    && a.avoid.length === b.avoid.length && a.avoid.every((r, i) => sameRect(r, b.avoid[i]!)));

/** What the card is placed against, read every frame: the target's visible rect, the content column, open layers. */
function readScene(target: HTMLElement | null, marks: Element[], avoid: string[]): Scene | null {
  if (typeof window === "undefined") return null;
  const vis = visibleRect(target);
  const t = vis && target && !occluded(target, vis) ? vis : null;
  const els = new Set<Element>(marks);
  for (const sel of avoid) { try { document.querySelectorAll(sel).forEach((el) => els.add(el)); } catch { /* bad selector */ } }
  els.delete(target as Element);
  return {
    target: t,
    bounds: contentBounds(t),
    obstacles: appLayerRects(),
    avoid: [...els].map((el) => visibleRect(el)).filter((r): r is Rect => !!r),
    inAgent: !!target?.closest('aside[aria-label="Agent"]'),
  };
}
const cardClass = "weft-tour-card flex flex-col gap-3 rounded-xl bg-card p-4 text-[13px] text-gray-12 shadow-[var(--shadow-modal)] outline-none";

function Inner({ v, h }: { v: CardView; h: CardHandlers }) {
  const pct = Math.round(((v.index + 1) / TOTAL) * 100);
  // Focus the title when a step is ready, and again when the card remounts in another shape (sheet to popover) while
  // focus was in the card; never pull focus back from the page the person tabbed into.
  useEffect(() => {
    if (!v.ready || !h.focusTitle) return;
    const raf = requestAnimationFrame(() => {
      const ae = document.activeElement;
      if (!ae || ae === document.body || ae.closest("[data-tour-card]")) h.titleRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [v.ready, v.step.id, h.focusTitle, h.titleRef]);
  const centered = v.step.target === null;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-gray-10 tabular-nums">{v.index + 1} of {TOTAL}</span>
        <div role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={TOTAL} aria-valuenow={v.index + 1} className="h-0.5 flex-1 overflow-hidden rounded-full bg-gray-4">
          <div className="h-full rounded-full bg-[var(--accent-9)] transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
        {centered ? null : (
          <Button variant="ghost" size={v.sheet ? "icon" : "icon-sm"} className={cn(v.sheet && "size-10")} aria-pressed={h.autoplay} aria-label={h.autoplay ? "Pause autoplay" : "Play autoplay"} data-tour-autoplay="" onClick={h.onToggleAutoplay}>
            {h.autoplay ? <Pause strokeWidth={1.5} /> : <Play strokeWidth={1.5} />}
          </Button>
        )}
        <Button variant="ghost" size={v.sheet ? "icon" : "icon-sm"} className={cn(v.sheet && "size-10")} aria-label="Exit tour" data-tour-exit="" onClick={h.onExit}><X strokeWidth={1.5} /></Button>
      </div>
      <div className="flex flex-col gap-1">
        <h2 ref={h.titleRef} id={h.titleId} tabIndex={-1} className="text-[14px] leading-5 font-semibold text-gray-12 outline-none">{v.offPage ? "You left the tour's page" : v.step.title}</h2>
        <p id={h.bodyId} className="text-[13px] leading-5 text-gray-11">{v.body}</p>
        {v.note ? <p data-tour-note="" className="text-[13px] leading-5 text-gray-10">{v.note}</p> : null}
        {v.status ? (
          <p data-tour-status={v.status.tone} className={cn("text-[13px] leading-5", v.status.tone === "waiting" ? "text-amber-11" : v.status.tone === "done" ? "text-green-11" : v.status.tone === "error" ? "text-red-11" : "text-gray-10")}>
            {v.status.tone === "working" ? <ShimmerText>{v.status.text}</ShimmerText> : v.status.text}
          </p>
        ) : null}
        {v.link ? <Link href={v.link.href} className="w-fit text-[13px] text-blue-11 hover:underline">{v.link.label}</Link> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {v.index > 0 && !v.offPage ? <Button variant="ghost" size={v.sheet ? "md" : "xs"} className={cn(v.sheet && "min-h-10")} data-tour-back="" onClick={h.onBack}>Back</Button> : null}
        <span className="flex-1" />
        {v.secondary.map((b) => <Button key={b.label} size={v.sheet ? "md" : "sm"} className={cn(v.sheet && "min-h-10")} data-testid={b.testid} onClick={b.onClick}>{b.label}</Button>)}
        {v.primary ? (
          <Button variant="primary" size={v.sheet ? "md" : "sm"} className={cn(v.sheet && "min-h-10")} data-tour-primary="" data-testid={v.primary.testid} disabled={!v.nextEnabled && v.primary.label === "Next"} onClick={v.primary.onClick}>
            {v.primary.label}{v.primary.kbd && h.desktop ? <Kbd className="ml-1 bg-transparent text-white/80 shadow-none">→</Kbd> : null}
          </Button>
        ) : null}
      </div>
    </>
  );
}

function dataAttrs(v: CardView) {
  return { "data-tour-card": "", "data-step": v.step.id, "data-ready": v.ready ? "true" : "false", "data-target-found": v.found ? "true" : "false", "data-target-match": v.match ?? "", "data-sheet": v.sheet ?? "" };
}

export function TourCard({ v, h }: { v: CardView; h: CardHandlers }) {
  const anchored = v.step.target !== null && !v.offPage && !v.sheet && v.found && !!v.target;
  // The card's own size (it grows with status lines), so placement uses what is on screen, not a guess.
  const [cardEl, setCardEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 360, height: 240 });
  useEffect(() => {
    if (!cardEl) return;
    const read = () => { const width = cardEl.offsetWidth, height = cardEl.offsetHeight; if (width && height) setSize((o) => (o.width === width && o.height === height ? o : { width, height })); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(cardEl);
    return () => ro.disconnect();
  }, [cardEl]);
  const scene = useFrameValue(() => (anchored ? readScene(v.target, v.marks, v.avoid) : null), sameScene, [anchored, v.target, v.marks, v.avoid.join("|")]);
  const prevSide = useRef<Side | "free" | null>(null);
  // The natural width (360 px), not the measured one, so a card narrowed to fit beside one target widens again.
  const natural = typeof window !== "undefined" ? Math.min(360, document.documentElement.clientWidth - 24) : 360;
  const place = scene && scene.target ? placeCard({ target: scene.target, card: { width: natural, height: size.height }, bounds: scene.bounds, obstacles: scene.obstacles, avoid: scene.avoid, order: sideOrder(v.step.dock, scene.inAgent), prev: prevSide.current, minWidth: 260 }) : null;
  prevSide.current = place?.side ?? null;
  const under = !!place && !!scene && scene.obstacles.some((o) => overlapArea({ left: place.left, top: place.top, right: place.left + (place.width ?? natural), bottom: place.top + size.height }, o) > 1);
  const placeRef = useRef(place);
  placeRef.current = place;
  // A point anchor at the card's computed top-left: the card sits exactly where placeCard put it, and floating-ui
  // re-reads it every frame (updatePositionStrategy "always").
  const virtualRef = useMemo(() => ({ current: { getBoundingClientRect: () => { const p = placeRef.current; return p ? new DOMRect(p.left, p.top, 0, 0) : new DOMRect(); } } }), []);
  const common = {
    onPointerEnter: () => h.onHover("pointer", true),
    onPointerLeave: () => h.onHover("pointer", false),
    // Keyboard focus only: a mouse click on Play must not pause autoplay straight away.
    onFocusCapture: (e: React.FocusEvent) => h.onHover("focus", e.target !== h.titleRef.current && (e.target as HTMLElement).matches?.(":focus-visible") === true),
    onBlurCapture: () => h.onHover("focus", false),
  };

  if (v.step.target === null && !v.offPage) {
    return (
      <Dialog.Root open modal>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/20" />
          <Dialog.Content
            {...dataAttrs(v)} {...common}
            aria-describedby={h.bodyId}
            onEscapeKeyDown={(e) => { e.preventDefault(); h.onExit(); }}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
            onOpenAutoFocus={(e) => { e.preventDefault(); h.titleRef.current?.focus({ preventScroll: true }); }}
            className={cn(cardClass, "fixed top-1/2 left-1/2 z-[71] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 p-5")}
          >
            <Dialog.Title asChild><span className="sr-only">{v.step.title}</span></Dialog.Title>
            <Inner v={v} h={h} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  if (!anchored || !place) {
    const t = scene?.target;
    const lower = !!t && t.top + (t.bottom - t.top) / 2 > (typeof window !== "undefined" ? window.innerHeight / 2 : 0);
    return (
      <FixedSheet v={v} h={h} common={common} top={v.sheet ? v.sheet === "top" : lower} bounds={v.sheet ? null : (scene?.bounds ?? (typeof window !== "undefined" ? contentBounds(null) : null))} cardRef={setCardEl}>
        <Inner v={v} h={h} />
      </FixedSheet>
    );
  }

  return (
    <Popover.Root open modal={false}>
      <Popover.Anchor virtualRef={virtualRef as never} />
      <Popover.Portal>
        <Popover.Content
          ref={setCardEl}
          {...dataAttrs(v)} {...common}
          data-place={place.side}
          role="dialog"
          aria-modal="false"
          aria-labelledby={h.titleId}
          aria-describedby={h.bodyId}
          side="bottom"
          align="start"
          sideOffset={0}
          avoidCollisions={false}
          updatePositionStrategy="always"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => { e.preventDefault(); h.onExit(); }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          // A modal drawer (expenses) sets body pointer-events: none; the card stays clickable on top of it.
          data-under-layer={under ? "true" : undefined}
          style={{ pointerEvents: "auto", ...(place.width ? { width: place.width } : {}) }}
          // With no clean spot left (a tall menu on a short screen), the card drops under the app's layers (z 50)
          // rather than covering the menu the person just opened.
          className={cn(cardClass, under ? "z-[49]" : "z-[70]", "w-[min(360px,calc(100vw-24px))]")}
        >
          <Inner v={v} h={h} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FixedSheet({ v, h, common, top, bounds, cardRef, children }: { v: CardView; h: CardHandlers; common: Record<string, (e: React.FocusEvent) => void>; top: boolean; bounds: Rect | null; cardRef: (el: HTMLElement | null) => void; children: ReactNode }) {
  const pos = top
    ? "top-[calc(var(--app-header-h,48px)+8px+env(safe-area-inset-top))]"
    : "bottom-[calc(16px+env(safe-area-inset-bottom))]";
  // Off a phone the unanchored card centres on the content column, not the window, so it never sits on the sidebar
  // or the docked agent panel.
  const left = bounds ? Math.round((bounds.left + bounds.right) / 2) : null;
  return (
    <div
      ref={cardRef}
      {...dataAttrs(v)} {...common}
      data-place="sheet"
      role="dialog"
      aria-modal="false"
      aria-labelledby={h.titleId}
      aria-describedby={h.bodyId}
      style={{ pointerEvents: "auto", ...(left !== null ? { left } : {}) }}
      className={cn(
        cardClass,
        "fixed z-[70]",
        v.sheet ? cn("inset-x-4 max-h-[50dvh] overflow-y-auto", pos) : cn("w-[min(360px,calc(100vw-24px))] -translate-x-1/2", left === null && "left-1/2", pos),
      )}
    >
      {children}
    </div>
  );
}
