import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design tokens add a numeric type scale (text-0 to text-12). Plain twMerge reads those as
// text colors, so `text-2 text-white` would drop one of them. Register them as font sizes.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] }],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
