"use client";
// "Reset the demo world?" (owner: tour): a Radix AlertDialog offered when preflight finds the world unsuitable, from
// the Viewing as menu and from the close step. POST /v1/sim/reset { profile: "rich" } rebuilds the world.
import { AlertDialog } from "radix-ui";
import { Button } from "@weft/ui/components";
import { TOUR_RESET_COPY as C } from "./steps";

/** `note`: an extra line under the body (the hosted demo's resets left). */
export function TourResetDialog({ open, from, reasons, busy, error, note, onReset, onSkip, onCancel }: {
  open: boolean; from: "start" | "menu" | null; reasons: string[]; busy: boolean; error: string | null; note?: string | null;
  onReset: () => void; onSkip: () => void; onCancel: () => void;
}) {
  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-black/20" />
        <AlertDialog.Content
          data-tour-reset=""
          onEscapeKeyDown={(e) => { e.preventDefault(); if (!busy) (from === "start" ? onSkip : onCancel)(); }}
          className="weft-tour-card fixed top-1/2 left-1/2 z-[71] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl bg-card p-5 text-[13px] shadow-[var(--shadow-modal)] outline-none"
        >
          <AlertDialog.Title className="text-[14px] font-semibold text-gray-12">{C.title}</AlertDialog.Title>
          <AlertDialog.Description className="leading-5 text-gray-11">{C.body}</AlertDialog.Description>
          {note ? <p data-tour-reset-note="" className="leading-5 text-gray-11">{note}</p> : null}
          {reasons.length ? <ul className="flex list-disc flex-col gap-0.5 pl-4 text-gray-10">{reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
          {error ? <p role="alert" data-tour-reset-error="" className="leading-5 text-red-11">{error}</p> : null}
          <p className="sr-only" aria-live="polite">{busy ? C.live : ""}</p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button size="sm" disabled={busy} data-tour-reset-skip="" onClick={from === "start" ? onSkip : onCancel}>{from === "start" ? C.skip : C.cancel}</Button>
            </AlertDialog.Cancel>
            <Button variant="primary" size="sm" disabled={busy} data-tour-reset-go="" onClick={onReset}>{busy ? C.running : error ? "Retry" : C.start}</Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
