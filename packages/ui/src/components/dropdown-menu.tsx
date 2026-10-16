"use client";
// DropdownMenu: Radix menu styled like PopoverContent (13 px text, radius 12, --shadow-menu). Items are 32 px rows at
// radius 8 with a gray-a3 highlight; keyboard focus moves the highlight, so the menu needs no separate focus ring.
import { DropdownMenu as M } from "radix-ui";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, children, ...props }: ComponentProps<typeof M.Content> & { children: ReactNode }) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          "z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-xl bg-card p-1 text-[13px] shadow-[var(--shadow-menu)] outline-none",
          "data-[state=open]:animate-[weft-pop_.2s_ease-out] motion-reduce:data-[state=open]:animate-none",
          className,
        )}
        {...props}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

const item = "relative flex min-h-8 cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-gray-12 outline-none select-none data-[highlighted]:bg-gray-a3 data-[disabled]:pointer-events-none data-[disabled]:text-gray-9";

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return <M.Item className={cn(item, className)} {...props} />;
}

/** A radio row with a trailing check on the selected value (role menuitemradio). */
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(item, "pr-8", className)} {...props}>
      {children}
      <M.ItemIndicator className="absolute right-2 inline-flex items-center text-gray-12"><Check className="size-4" strokeWidth={1.5} aria-hidden /></M.ItemIndicator>
    </M.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2 pt-1.5 pb-1 text-1 font-medium text-gray-11", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn("-mx-1 my-1 h-px bg-[var(--app-border)]", className)} {...props} />;
}
