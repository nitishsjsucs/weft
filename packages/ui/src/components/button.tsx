import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn";

// Buttons follow the reference shapes: small, crisp, radius 7 to 8, ink primary, white ring secondary.
export const buttonVariants = cva(
  "weft-press inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--blue-9)] focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-gray-12 text-white shadow-[var(--shadow-btn-dark)] hover:bg-[#363636] dark:bg-gray-12 dark:text-[#202020]",
        secondary: "bg-card text-foreground shadow-[var(--shadow-border),var(--shadow-xs)] hover:bg-gray-2",
        ghost: "text-gray-11 hover:bg-gray-a3 hover:text-foreground",
        accent: "bg-accent-9 text-white hover:bg-accent-10",
        danger: "bg-card text-red-11 shadow-[var(--shadow-border),var(--shadow-xs)] hover:bg-red-3",
      },
      size: {
        xs: "h-6 rounded-md px-2 text-1",
        sm: "h-7 rounded-lg px-2.5 text-[13px]",
        md: "h-8 rounded-lg px-3 text-2",
        lg: "h-10 rounded-[9px] px-4 text-2",
        icon: "size-8 rounded-lg",
        "icon-sm": "size-7 rounded-md",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} type={asChild ? undefined : (type ?? "button")} {...props} />;
}
