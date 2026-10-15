"use client";
import { Popover as P } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export function PopoverContent({ className, children, ...props }: ComponentProps<typeof P.Content> & { children: ReactNode }) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn("z-50 w-[min(360px,calc(100vw-24px))] rounded-xl bg-card p-3 text-[13px] shadow-[var(--shadow-menu)] outline-none data-[state=open]:animate-[weft-pop_.2s_ease-out]", className)}
        {...props}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
