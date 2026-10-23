// The hosted shell's build-time switches (docs/cloudflare/design.md 3.5 and 6). NEXT_PUBLIC_* values are inlined by
// Next at build time, so with NEXT_PUBLIC_WEFT_HOSTED unset every hosted branch is dead code and the Node app is
// exactly what it was.

/** True in the hosted build (`NEXT_PUBLIC_WEFT_HOSTED=1`). */
export const HOSTED = process.env.NEXT_PUBLIC_WEFT_HOSTED === "1";

/**
 * Cloudflare's published always-pass test sitekey, for local, Miniflare and `wrangler dev` runs. The deploy build sets
 * NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY to the `weft` widget's sitekey (public, not a secret).
 */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";
export const TURNSTILE_SITEKEY = process.env.NEXT_PUBLIC_WEFT_TURNSTILE_SITEKEY || TURNSTILE_TEST_SITEKEY;
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The web's hosted interval multiplier (design 4.5): every poll interval doubles on the hosted build. */
export const HOSTED_POLL_MULTIPLIER = 2;
/** Degradation level 1 and above triple the hosted intervals (design 6.5). */
export const DEGRADED_POLL_MULTIPLIER = 3;
/** Idle backoff (design 4.5): after 2 minutes without input, intervals grow 4 times, capped at 60 s. */
export const IDLE_AFTER_MS = 120_000;
export const IDLE_MULTIPLIER = 4;
export const IDLE_CAP_MS = 60_000;
/** A human check (a 428's Turnstile run) still open after this long fails, and the waiting requests get their 428. */
export const HUMAN_CHECK_WAIT_MS = 60_000;
/** The run trace fallback poll while SSE is unavailable: 1 s on Node, 5 s hosted (design 3.4). */
export const HOSTED_TRACE_POLL_MS = 5_000;
/** Client keepalive on /api/_live: the slot answers with the hibernation auto-response, so it never wakes the object. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";
export const LIVE_PING_EVERY_MS = 45_000;
export const LIVE_PONG_TIMEOUT_MS = 10_000;
