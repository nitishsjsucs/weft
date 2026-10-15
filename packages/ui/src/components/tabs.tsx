"use client";
import { Tabs as T } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";

export const Tabs = T.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return <T.List className={cn("flex items-center gap-1 overflow-x-auto border-b border-[var(--app-border)]", className)} {...props} />;
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
