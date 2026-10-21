// Global invalidation (t5-app): every mutation bumps the version and each mounted query refetches. A module of its own
// so the hosted session code can invalidate without importing the hooks (which import it).
let version = 0;
const versionSubs = new Set<() => void>();
export function invalidate() { version++; versionSubs.forEach((f) => f()); }
/** Runs `cb` after every invalidate() (a mutation anywhere in the app); returns the unsubscribe. */
export function onInvalidate(cb: () => void): () => void { versionSubs.add(cb); return () => { versionSubs.delete(cb); }; }
export function getVersion(): number { return version; }
export function subscribeVersion(cb: () => void): () => void { versionSubs.add(cb); return () => { versionSubs.delete(cb); }; }
