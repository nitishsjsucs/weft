// Run queue (SPEC 9.6): one live-provider run at a time (concurrency 1 for openai), 8 for scripted. The UI shows the
// queue position.
export interface RunQueue {
  push(id: string, job: () => Promise<void>): Promise<void>;
  position(id: string): number | null;   // 0 = running, 1 = next, null = not queued
  idle(): Promise<void>;
  readonly concurrency: number;
}

export function concurrencyFor(providerId: string): number {
  return providerId === "scripted" ? 8 : 1;
}

export function createRunQueue(concurrency: number): RunQueue {
  const waiting: { id: string; job: () => Promise<void>; done: () => void; fail: (e: unknown) => void }[] = [];
  const running = new Set<string>();
  let idleWaiters: (() => void)[] = [];

  const pump = () => {
    while (running.size < concurrency && waiting.length) {
      const next = waiting.shift()!;
      running.add(next.id);
      next.job().then(next.done, next.fail).finally(() => {
        running.delete(next.id);
        pump();
        if (running.size === 0 && waiting.length === 0) {
          const ws = idleWaiters;
          idleWaiters = [];
          for (const w of ws) w();
        }
      });
    }
  };

  return {
    concurrency,
    push(id, job) {
      return new Promise<void>((done, fail) => {
        waiting.push({ id, job, done, fail });
        pump();
      });
    },
    position(id) {
      if (running.has(id)) return 0;
      const i = waiting.findIndex((w) => w.id === id);
      return i < 0 ? null : i + 1;
    },
    idle() {
      if (running.size === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },
  };
}
