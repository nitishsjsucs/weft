import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/** White card, radius 12, 1 px hairline and shadow-xs (design.md 10.1 widget anatomy). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-[var(--app-border)] bg-card shadow-xs", className)} {...props} />;
}

/** Widget header that sits outside the card: icon tile, label, optional trailing node. */
export function CardHeading({ icon, children, trailing, className }: { icon?: ReactNode; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex items-center gap-2 text-2 text-gray-11", className)}>
      {icon ? <span className="grid size-6 place-items-center rounded-md bg-gray-3 text-gray-11 [&_svg]:size-3.5">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </div>
  );
}

export function CardSection({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-3 border-t border-[var(--app-border)] bg-gray-2 px-4 py-2.5 text-1 text-gray-11 rounded-b-xl", className)} {...props} />;
}
