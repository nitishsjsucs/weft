import type { ReactNode } from "react";
import { cn } from "@weft/ui";
import { CrumbLabel } from "./shell/crumbs";

/**
 * Page widths (research/wave3/topbar-design.md 7.6): three tokens instead of six ad hoc max widths. `default` (1100)
 * for most views, `wide` (1280) for tables such as People, a payroll run and Audit, `narrow` (760) for forms and
 * Settings. One padding everywhere.
 */
export type PageWidth = "default" | "wide" | "narrow";
const WIDTH: Record<PageWidth, string> = {
  default: "max-w-[var(--page-w-default)]",
  wide: "max-w-[var(--page-w-wide)]",
  narrow: "max-w-[var(--page-w-narrow)]",
};

export function PageBody({ width = "default", className, children }: { width?: PageWidth; className?: string; children: ReactNode }) {
  return <div data-page-width={width} className={cn("mx-auto w-full px-4 py-6 tablet:px-8 tablet:py-8", WIDTH[width], className)}>{children}</div>;
}

/**
 * Page title block. A detail view passes `crumb` (usually the same text as the title) so the top bar's breadcrumb
 * reads the record's name instead of its id.
 */
export function PageHeader({ title, subtitle, actions, meta, crumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; meta?: ReactNode; crumb?: string }) {
  return (
    <div className="@container mb-6"><div className="flex flex-col gap-3 @min-[820px]:flex-row @min-[820px]:items-start">
      {crumb ? <CrumbLabel label={crumb} /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="text-6 font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-[640px] text-2 text-gray-11">{subtitle}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div></div>
  );
}

export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <PageBody width="narrow" className="py-8">
      <PageHeader title={title} subtitle={note} />
    </PageBody>
  );
}
