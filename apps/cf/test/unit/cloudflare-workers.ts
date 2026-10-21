// "cloudflare:workers" for the unit suite (vitest.config.ts aliases it): just the base classes' constructor, so a
// Durable Object class runs on Node over a fake ctx and env. The Miniflare suite runs the real runtime.
export class DurableObject<Env = unknown> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
export class WorkerEntrypoint<Env = unknown> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
export class WorkflowEntrypoint<Env = unknown> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
