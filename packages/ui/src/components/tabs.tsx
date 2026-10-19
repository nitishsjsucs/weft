"use client";
import { Tabs as T } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useEdgeFade } from "./edge-fade";

export const Tabs = T.Root;
// A strip wider than its column scrolls sideways (no scrollbar) and fades the edge it runs past; the active tab is
// scrolled into view. On a phone the strip wraps onto a second row instead, so every tab shows without a scroll.
export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  const ref = useEdgeFade<HTMLDivElement>();
  return (
    <T.List
      ref={ref}
      data-edge-fade=""
      className={cn("flex min-w-0 max-w-full items-center gap-1 max-tablet:flex-wrap max-tablet:gap-y-0 overflow-x-auto overflow-y-hidden border-b border-[var(--app-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
      onFocusCapture={(e) => { (e.target as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" }); }}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "-mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 text-2 text-gray-11 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] data-[state=active]:border-gray-12 data-[state=active]:font-medium data-[state=active]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn("pt-4 outline-none", className)} {...props} />;
}
