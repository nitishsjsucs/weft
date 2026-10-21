// Per-world module state (docs/cloudflare/design.md 4.2 and 6.4). Several CompanyDO instances can share one isolate,
// so state that is a process singleton on Node (the trace redactor, its learned tokens, the run-start recall notes) is
// kept per world. The world comes from the WorldScope the host binds (@weft/db's AsyncLocalStorage scope on the
// durable platform); unbound, or outside any world, it is NODE_WORLD, so Node keeps exactly one world.
import { NODE_WORLD, type WorldScope } from "../../contracts/src/ext/cf-db";

let scope: Pick<WorldScope, "current"> | null = null;

/** Binds the scope whose current() names the world (CompanyDO binds @weft/db's worldScope once per isolate). */
export function bindWorldScope(s: Pick<WorldScope, "current"> | null): void {
  scope = s;
}

export function currentWorld(): string {
  try { return scope?.current() ?? NODE_WORLD; } catch { return NODE_WORLD; }
}

/** A value per world, created on first use inside each world. */
export function perWorld<T>(make: (world: string) => T): () => T {
  const byWorld = new Map<string, T>();
  return () => {
    const w = currentWorld();
    if (!byWorld.has(w)) byWorld.set(w, make(w));
    return byWorld.get(w)!;
  };
}
