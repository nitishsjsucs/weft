"use client";
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../cn";
import { useEdgeFade } from "./edge-fade";

// Presentational table parts (design.md 13.3: header 12/500 gray-11, rows 48 px, tabular right-aligned money).
// apps/web drives them with TanStack Table v9 useTable.
// The wrapper scrolls sideways when the table is wider than its column and fades the edge it runs past.
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  const ref = useEdgeFade<HTMLDivElement>();
  return (
    <div ref={ref} data-edge-fade="" className="w-full min-w-0 overflow-x-auto">
      <table className={cn("w-full border-collapse text-2", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-[var(--app-border)]", className)} {...props} />;
}
export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}
export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-[var(--app-border)] transition-colors", className)} {...props} />;
}
export function TH({ className, numeric, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th className={cn("h-9 px-3 text-left align-middle text-1 font-medium whitespace-nowrap text-gray-11", numeric && "text-right", className)} {...props} />;
}
export function TD({ className, numeric, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn("h-12 px-3 align-middle", numeric && "tabular text-right whitespace-nowrap", className)} {...props} />;
}
