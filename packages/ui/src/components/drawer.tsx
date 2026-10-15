"use client";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** Right-side sheet built on the radix Dialog. */
export function Drawer({ open, onOpenChange, title, description, children, footer, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20 data-[state=open]:animate-[weft-pop_.2s_ease-out]" />
        <Dialog.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col border-l border-[var(--app-border)] bg-background shadow-[var(--shadow-modal)] outline-none data-[state=open]:animate-[weft-slide-up_.2s_ease-out]",
            className,
          )}
        >
          <div className="flex items-start gap-3 border-b border-[var(--app-border)] px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-3 font-semibold">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-1 text-gray-11">{description}</Dialog.Description> : <Dialog.Description className="sr-only">Details</Dialog.Description>}
            </div>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-gray-11 hover:bg-gray-a3" aria-label="Close">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-[var(--app-border)] px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
