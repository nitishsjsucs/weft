import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions, meta }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="@container mb-6"><div className="flex flex-col gap-3 @min-[820px]:flex-row @min-[820px]:items-start">
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
    <div className="mx-auto w-full max-w-[880px] px-4 py-8 tablet:px-8">
      <PageHeader title={title} subtitle={note} />
    </div>
  );
}
