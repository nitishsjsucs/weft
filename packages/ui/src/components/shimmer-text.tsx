import type { ReactNode } from "react";
import { cn } from "../cn";

/** Agent "working" text with the 2.5 s shimmer (reduced motion falls back to plain text in tokens.css). */
export function ShimmerText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("weft-shimmer", className)}>{children}</span>;
}
