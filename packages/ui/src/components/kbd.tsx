import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cn("inline-grid h-4 min-w-4 place-items-center rounded-[4px] border border-[var(--app-border)] bg-card px-1 font-sans text-[10px] text-gray-11", className)} {...props} />;
}
