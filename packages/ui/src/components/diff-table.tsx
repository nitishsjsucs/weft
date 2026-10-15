import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface DiffRow { label: string; before: string; after: string }

/** Before and after table for proposals. Values render as text (React escapes them); nothing is truncated. */
export function DiffTable({ rows, className, ...props }: { rows: DiffRow[] } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-[var(--app-border)]", className)} {...props}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-[var(--app-border)] bg-gray-2 text-left text-1 text-gray-11">
            <th className="px-3 py-1.5 font-medium">Field</th>
            <th className="px-3 py-1.5 font-medium">Before</th>
            <th className="px-3 py-1.5 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const changed = r.before !== r.after;
            return (
              <tr key={`${r.label}-${i}`} className="border-b border-[var(--app-border)] last:border-0 align-top">
                <td className="px-3 py-2 text-gray-11">{r.label}</td>
                <td className={cn("tabular px-3 py-2 break-words whitespace-pre-wrap", changed && "text-gray-10 line-through decoration-gray-8")}>{r.before}</td>
                <td className={cn("tabular px-3 py-2 break-words whitespace-pre-wrap", changed && "font-medium text-foreground")}>{r.after}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
