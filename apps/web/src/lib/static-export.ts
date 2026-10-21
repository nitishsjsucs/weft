// Build-time switches for Weft on Cloudflare (docs/cloudflare/design.md 3.5). Read only by server components and
// next.config.ts, at build time: WEFT_STATIC_EXPORT=1 builds the static export served as Workers static assets.
// Without it, every page behaves exactly as on Node.

/** True while `next build` runs the static export. */
export const STATIC_EXPORT = process.env.WEFT_STATIC_EXPORT === "1";

/** The id every dynamic `[id]` segment exports as its one shell page; the real id comes from the URL in the browser. */
export const SHELL_ID = "_";

/**
 * `generateStaticParams` for the five `[id]` pages: one shell (`/app/<section>/_/`) in the static export, which
 * `_redirects` serves for every id. Undefined on Node, so those routes stay rendered on demand as before.
 */
export const shellStaticParams: (() => Promise<{ id: string }[]>) | undefined = STATIC_EXPORT ? async () => [{ id: SHELL_ID }] : undefined;
