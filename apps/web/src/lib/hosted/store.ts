// A minimal external store for the hosted shell's module state (read with useSyncExternalStore).
export interface Store<T> { get(): T; set(patch: Partial<T> | ((s: T) => Partial<T>)): void; subscribe(cb: () => void): () => void }

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}
