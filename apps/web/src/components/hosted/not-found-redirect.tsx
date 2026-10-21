"use client";
// The hosted 404 page's one job besides saying "not found": a record link without its trailing slash
// ("/app/people/wrk_0026") misses the `_redirects` shell rule, so it lands here; send it to the slashed URL, which the
// rule serves from the section's shell. Every other path stays a plain 404.
import { useEffect } from "react";
import { ROUTE_SECTIONS } from "@/lib/route-id";

/** The slashed URL for a record path that lost its trailing slash, or null. Exported for tests. */
export function shellRedirect(pathname: string, search = "", hash = ""): string | null {
  const m = /^\/app\/([a-z-]+)\/([^/.]+)$/.exec(pathname);
  if (!m || !(ROUTE_SECTIONS as readonly string[]).includes(m[1]!)) return null;
  return `${pathname}/${search}${hash}`;
}

export function NotFoundRedirect() {
  useEffect(() => {
    const to = shellRedirect(window.location.pathname, window.location.search, window.location.hash);
    if (to) window.location.replace(to);
  }, []);
  return null;
}
