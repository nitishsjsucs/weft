import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * Server-sent events helper (SPEC 9.6). `subscribe` receives a send function and returns an unsubscribe.
 * A heartbeat comment every 15 s keeps proxies from closing the stream; next.config.ts sets compress false.
 */
export function sse<T>(c: Context, subscribe: (send: (event: string, data: T) => void, close: () => void) => () => void, opts: { heartbeatMs?: number } = {}): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let wake: () => void = () => undefined;
    const done = new Promise<void>((r) => { wake = r; });
    const close = () => { closed = true; wake(); };
    const unsubscribe = subscribe((event, data) => { if (!closed) void stream.writeSSE({ event, data: JSON.stringify(data) }); }, close);
    stream.onAbort(close);
    const beat = setInterval(() => { if (!closed) void stream.write(": ping\n\n"); }, opts.heartbeatMs ?? 15_000);
    try { await done; } finally { clearInterval(beat); unsubscribe(); }
  });
}
