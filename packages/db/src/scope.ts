// WorldScope (docs/cloudflare/design.md 4.2 and 6.4). Several Durable Object instances can share one isolate, so module
// state that is a process singleton on Node (the write-lock tail, the auth windows, otel `learned`, `recallNotes`,
// the trace redactor, webhook receivers) is keyed by the world the current async context serves. Outside any
// `run`, the world is NODE_WORLD, so Node keeps exactly one world and today's behavior.
import { AsyncLocalStorage } from "node:async_hooks";
import { NODE_WORLD, type WorldScope } from "../../contracts/src/ext/cf-db";

const als = new AsyncLocalStorage<string>();

export const worldScope: WorldScope = {
  run<T>(world: string, fn: () => T): T {
    if (typeof world !== "string" || world.length === 0) throw new TypeError("WorldScope.run needs a world name");
    return als.run(world, fn);
  },
  current: () => als.getStore() ?? NODE_WORLD,
  keyed<T>(make: (world: string) => T): () => T {
    const values = new Map<string, T>();
    return () => {
      const world = als.getStore() ?? NODE_WORLD;
      let v = values.get(world);
      if (v === undefined && !values.has(world)) { v = make(world); values.set(world, v); }
      return v as T;
    };
  },
};

/** Per-world values with an explicit drop, for state a world reset must forget (the hosted reset calls it). */
export function keyedWithReset<T>(make: (world: string) => T): { get: () => T; drop: (world?: string) => void } {
  const values = new Map<string, T>();
  return {
    get() {
      const world = worldScope.current();
      if (!values.has(world)) values.set(world, make(world));
      return values.get(world) as T;
    },
    drop(world = worldScope.current()) { values.delete(world); },
  };
}
