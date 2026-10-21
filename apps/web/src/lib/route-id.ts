"use client";
// Real ids for the static export's `[id]` shells (docs/cloudflare/design.md 3.5). The export builds one page per
// dynamic section, `/app/<section>/_/`, and `_redirects` serves it for every id; the page receives `_` and the real id
// comes from the URL. On Node the page receives the real id and this hook returns it unchanged.
import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/** The five dynamic sections. */
export const ROUTE_SECTIONS = ["people", "payroll", "runs", "routines", "offboarding"] as const;
export type RouteSection = (typeof ROUTE_SECTIONS)[number];
/** Matches lib/static-export.ts SHELL_ID (that file is server-only). */
export const SHELL_ID = "_";

/** The id in "/app/<section>/<id>" or "/app/<section>/<id>/", decoded; null when the path is not a record page. */
export function idFromPath(section: RouteSection, pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const prefix = `/app/${section}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  if (!rest || rest.includes("/")) return null;
  try { return decodeURIComponent(rest); } catch { return null; }
}

/** The id a record page shows: `id` itself, or for the shell (`_`) the id in the URL. */
export function resolveRouteId(section: RouteSection, id: string, pathname: string | null | undefined): string {
  if (id !== SHELL_ID) return id;
  return idFromPath(section, pathname) ?? id;
}

const noSubscribe = () => () => {};

/**
 * The record id for a `[id]` page. Hydration reads the prerendered `_` (so the shell's HTML matches), then React
 * re-renders with the id from the URL. A component gets SHELL_ID only during that first pass and renders nothing.
 */
export function useRouteId(section: RouteSection, id: string): string {
  const pathname = usePathname();
  return useSyncExternalStore(noSubscribe, () => resolveRouteId(section, id, pathname), () => id);
}
