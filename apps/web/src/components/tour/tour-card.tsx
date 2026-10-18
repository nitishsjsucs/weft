"use client";
// The tour card (owner: tour). Anchored steps use a Radix Popover with a virtual anchor on the target, so
// floating-ui's autoUpdate follows scroll and resize; centered steps (welcome, close) use a Radix Dialog over the
// app's bg-black/20 scrim; a missing target or a phone gets a fixed sheet. Styling follows PopoverContent and
// research/design.md: bg-card, rounded-xl, --shadow-modal, 13 px text, the madder accent for progress.
import { Dialog, Popover } from "radix-ui";
import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Pause, Play, X } from "lucide-react";
import { Button, Kbd, ShimmerText } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TOUR_STEPS, type TourStep } from "./steps";
import { useTrackedBox } from "./tour-ring";

export type StatusTone = "working" | "waiting" | "done" | "error" | "muted";

export interface CardView {
  step: TourStep;
  index: number;
  body: string;
  ready: boolean;
  found: boolean;
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
}

export interface CardHandlers {
  onBack: () => void;
  onExit: () => void;
  onToggleAutoplay: () => void;
  onHover: (inside: boolean) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
  bodyId: string;
  titleId: string;
  autoplay: boolean;
  desktop: boolean;
}

const TOTAL = TOUR_STEPS.length;
type Side = "top" | "right" | "bottom" | "left";

/**
 * The side with room for the card next to the visible part of the target, or null when none has room (a tall or
 * wide target such as the agent panel's full height on a small screen): the card then docks as a fixed sheet.
 */
export function pickSide(box: { top: number; left: number; width: number; height: number }, vw: number, vh: number, dock?: "side"): { side: Side; align: "start" | "center" } | null {
  const W = 372, H = 280;
  const room: Record<Side, number> = { bottom: vh - (box.top + box.height), top: box.top, left: box.left, right: vw - (box.left + box.width) };
  const order: Side[] = dock === "side" ? ["left", "right", "bottom", "top"] : ["bottom", "top", "left", "right"];
  for (const side of order) if (room[side] >= (side === "left" || side === "right" ? W : H)) return { side, align: side === "left" || side === "right" ? "start" : "center" };
  return null;
}

/** The target's rect clipped to the viewport, so the card anchors to what is on screen. */
function clipped(el: HTMLElement | null): DOMRect {
  if (!el) return new DOMRect();
  const r = el.getBoundingClientRect();
  const top = Math.max(0, r.top), left = Math.max(0, r.left);
  const bottom = Math.min(window.innerHeight, r.bottom), right = Math.min(document.documentElement.clientWidth, r.right);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
const cardClass = "weft-tour-card flex flex-col gap-3 rounded-xl bg-card p-4 text-[13px] text-gray-12 shadow-[var(--shadow-modal)] outline-none";

function Inner({ v, h }: { v: CardView; h: CardHandlers }) {
  const pct = Math.round(((v.index + 1) / TOTAL) * 100);
  const centered = v.step.target === null;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-gray-10 tabular-nums">{v.index + 1} of {TOTAL}</span>
        <div role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={TOTAL} aria-valuenow={v.index + 1} className="h-0.5 flex-1 overflow-hidden rounded-full bg-gray-4">
          <div className="h-full rounded-full bg-[var(--accent-9)] transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
        {centered ? null : (
          <Button variant="ghost" size="icon-sm" aria-pressed={h.autoplay} aria-label={h.autoplay ? "Pause autoplay" : "Play autoplay"} data-tour-autoplay="" onClick={h.onToggleAutoplay}>
            {h.autoplay ? <Pause strokeWidth={1.5} /> : <Play strokeWidth={1.5} />}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Exit tour" data-tour-exit="" onClick={h.onExit}><X strokeWidth={1.5} /></Button>
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
  return { "data-tour-card": "", "data-step": v.step.id, "data-ready": v.ready ? "true" : "false", "data-target-found": v.found ? "true" : "false", "data-sheet": v.sheet ?? "" };
}

export function TourCard({ v, h }: { v: CardView; h: CardHandlers }) {
  const targetRef = useRef<HTMLElement | null>(null);
  targetRef.current = v.target;
  const virtualRef = useMemo(() => ({ current: { getBoundingClientRect: () => clipped(targetRef.current), get contextElement() { return targetRef.current ?? undefined; } } }), []);
  // Re-measured on scroll and resize, so the side follows the target.
  const box = useTrackedBox(v.found && !v.sheet ? v.target : null, 0);
  const place = box && typeof window !== "undefined" ? pickSide(box, document.documentElement.clientWidth, window.innerHeight, v.step.dock) : null;
  const common = { onPointerEnter: () => h.onHover(true), onPointerLeave: () => h.onHover(false), onFocusCapture: () => h.onHover(true), onBlurCapture: () => h.onHover(false) };

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

  if (v.sheet || !v.found || !v.target || !place) {
    const lower = !!box && box.top + box.height / 2 > (typeof window !== "undefined" ? window.innerHeight / 2 : 0);
    return (
      <FixedSheet v={v} h={h} common={common} top={v.sheet ? v.sheet === "top" : lower}>
        <Inner v={v} h={h} />
      </FixedSheet>
    );
  }

  return (
    <Popover.Root open modal={false}>
      <Popover.Anchor virtualRef={virtualRef as never} />
      <Popover.Portal>
        <Popover.Content
          {...dataAttrs(v)} {...common}
          role="dialog"
          aria-modal="false"
          aria-labelledby={h.titleId}
          aria-describedby={h.bodyId}
          side={place.side}
          align={place.align}
          sticky="always"
          sideOffset={12}
          collisionPadding={12}
          avoidCollisions
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => { e.preventDefault(); h.onExit(); }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          // A modal drawer (expenses) sets body pointer-events: none; the card stays clickable on top of it.
          style={{ pointerEvents: "auto" }}
          className={cn(cardClass, "z-[70] w-[min(360px,calc(100vw-24px))]")}
        >
          <Inner v={v} h={h} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FixedSheet({ v, h, common, top, children }: { v: CardView; h: CardHandlers; common: Record<string, () => void>; top: boolean; children: ReactNode }) {
  const pos = top
    ? "top-[calc(var(--app-header-h,48px)+8px+env(safe-area-inset-top))]"
    : "bottom-[calc(16px+env(safe-area-inset-bottom))]";
  return (
    <div
      {...dataAttrs(v)} {...common}
      role="dialog"
      aria-modal="false"
      aria-labelledby={h.titleId}
      aria-describedby={h.bodyId}
      style={{ pointerEvents: "auto" }}
      className={cn(
        cardClass,
        "fixed z-[70]",
        v.sheet ? cn("inset-x-4 max-h-[50dvh] overflow-y-auto", pos) : cn("left-1/2 w-[min(360px,calc(100vw-24px))] -translate-x-1/2", pos),
      )}
    >
      {children}
    </div>
  );
}
