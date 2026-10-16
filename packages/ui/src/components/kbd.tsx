import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/**
 * One keyboard chip for a whole shortcut ("⌘K" or "Ctrl K"), never one chip per key: 18 px tall, 11/500, a hairline
 * ring edge (research/wave3/topbar-design.md 5.8).
 */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cn("inline-flex h-[18px] shrink-0 items-center rounded-sm bg-card px-[5px] font-sans text-[11px] leading-none font-medium whitespace-nowrap text-gray-11 shadow-[var(--shadow-border)]", className)} {...props} />;
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. Pass the platform string (navigator.userAgentData?.platform ?? navigator.platform). */
export function shortcutLabel(key: string, platform: string | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "") ? `⌘${key}` : `Ctrl ${key}`;
}
