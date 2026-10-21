// The alarm's fetch counter for every outbound fetch the invocation makes (design 8.1 and 11.4: at most
// MAX_FETCHES_PER_ALARM of Workers Free's 50). A model transport built over the global fetch (the durable platform
// gives its providers no fetch of their own; contract request cf2 item 1) is counted too: CompanyDO's module replaces
// globalThis.fetch once with a wrapper that charges the counter of the alarm invocation it runs in. The counter rides
// an AsyncLocalStorage store, so Durable Objects sharing an isolate keep their own counts, and a fetch made outside an
// alarm passes straight through. Counters wrap rawFetch, so no fetch is counted twice.
import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchCounter } from "../../shared/contracts";

const scope = new AsyncLocalStorage<FetchCounter>();

/** The runtime's fetch, before the wrapper. */
export const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);

let installed = false;

/** Replaces globalThis.fetch with the counting wrapper (once per isolate). */
export function installCountedFetch(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const counter = scope.getStore();
    return counter ? counter.wrap(rawFetch)(input, init) : rawFetch(input, init);
  }) as typeof fetch;
}

/** Runs an alarm invocation's work with its counter charged for every global fetch in it (and what it starts). */
export function countFetchesIn<T>(counter: FetchCounter, fn: () => Promise<T>): Promise<T> {
  return scope.run(counter, fn);
}
