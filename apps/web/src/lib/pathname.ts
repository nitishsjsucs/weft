"use client";
// Pathnames without the static export's trailing slash. The hosted build sets `trailingSlash: true`, so the browser
// URL reads "/app/people/" there and "/app/people" on Node; every comparison in the app uses the slash-free form, so
// active nav, breadcrumbs, the tour's route checks and "Ask about this page" read the same on both.
import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { ROUTE_SECTIONS } from "./route-id";

/** Set by next.config.ts in the static export only (not on Node, not under next dev). */
const EXPORT_SHELLS = process.env.NEXT_PUBLIC_WEFT_STATIC_EXPORT === "1";

/** "/app/people/" reads "/app/people"; "/" stays "/". */
export function normalizePath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") || "/" : p;
}

/** The shell a record path was prerendered as: "/app/people/wrk_0026" reads "/app/people/_". */
export function shellPathname(p: string): string {
  const m = /^\/app\/([a-z-]+)\/[^/]+$/.exec(p);
  return m && (ROUTE_SECTIONS as readonly string[]).includes(m[1]!) ? `/app/${m[1]}/_` : p;
}

/** The pathname a render should use: during hydration in the static export, the shell's own path (so a record page's
 * breadcrumb and panel match the prerendered HTML), then the real one. Anywhere else, the real pathname. */
export function hydrationPathname(real: string, exportShells = EXPORT_SHELLS): string {
  return exportShells ? shellPathname(real) : real;
}

const noSubscribe = () => () => {};

/** usePathname() without a trailing slash. */
export function useAppPathname(): string {
  const real = normalizePath(usePathname() ?? "/");
  return useSyncExternalStore(noSubscribe, () => real, () => hydrationPathname(real));
}

/** window.location.pathname without a trailing slash (browser only). */
export function currentPathname(): string {
  return normalizePath(window.location.pathname);
}
