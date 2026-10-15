import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export const badgeVariants = cva("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium leading-none [&_svg]:size-3", {
  variants: {
    tone: {
      gray: "bg-gray-3 text-gray-11",
      blue: "bg-blue-3 text-blue-11",
      green: "bg-green-3 text-green-11",
      amber: "bg-amber-3 text-amber-11",
      red: "bg-red-3 text-red-11",
      accent: "bg-accent-9 text-white",
      outline: "bg-card text-gray-11 shadow-[var(--shadow-border)]",
    },
    size: { xs: "h-4 px-1 text-[10px]", sm: "h-5 px-1.5 text-0", md: "h-6 px-2 text-1" },
  },
  defaultVariants: { tone: "gray", size: "sm" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
