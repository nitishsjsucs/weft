"use client";
// Breadcrumb titles for detail pages (research/wave3/topbar-design.md 7.1). A detail view renders <CrumbLabel> with
// the same text as its H1, and the bar shows "People > Vic Akisole" instead of the raw "wrk_0001". While
// the record loads the bar shows the id in a small mono face.
import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useAppPathname } from "@/lib/pathname";
import { useGet } from "@/lib/api/hooks";
import { period } from "../format";

type Title = { path: string; label: string } | null;
interface CrumbCtx { title: Title; set: Dispatch<SetStateAction<Title>> }
const Ctx = createContext<CrumbCtx>({ title: null, set: () => {} });

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [title, set] = useState<CrumbCtx["title"]>(null);
  return <Ctx.Provider value={{ title, set }}>{children}</Ctx.Provider>;
}

/** The record title registered for the current path, or null (a stale title from another page never shows). */
export function useCrumbTitle(): string | null {
  const { title } = useContext(Ctx);
  const pathname = useAppPathname();
  return title && title.path === pathname ? title.label : null;
}

/** Sets the last breadcrumb to `label` while mounted. Renders nothing. */
export function CrumbLabel({ label }: { label: string | null | undefined }) {
  const { set } = useContext(Ctx);
  const pathname = useAppPathname();
  useEffect(() => {
    if (!label) return;
    set({ path: pathname, label });
    // Clear only this label, so another CrumbLabel still mounted for the page keeps its title.
    return () => set((cur) => (cur && cur.path === pathname && cur.label === label ? null : cur));
  }, [label, pathname, set]);
  return null;
}

/** Person detail: the worker's display name. The route answers `{ worker, ... }` (people-view's toDetail reads the same). */
export function WorkerCrumb({ id }: { id: string }) {
  const w = useGet("/v1/workers/:id", { params: { id } });
  const data = w.data as unknown as { worker?: { displayName?: string }; displayName?: string } | undefined;
  return <CrumbLabel label={data?.worker?.displayName ?? data?.displayName} />;
}

/** Payroll run detail: the pay period, as the run's H1 reads ("Sep 1 to Sep 15"). */
export function PayrollCrumb({ id }: { id: string }) {
  const r = useGet("/v1/payrolls/:id", { params: { id } });
  return <CrumbLabel label={r.data ? period(r.data.periodStart, r.data.periodEnd) : null} />;
}
