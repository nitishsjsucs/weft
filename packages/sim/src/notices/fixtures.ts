// Where the notice fixtures come from (docs/cloudflare/design.md 4.1, track cf2-platform). Node reads them from the
// repo, as before; the durable platform hands in its FixtureSource (the generated module apps/cf/generated/fixtures.ts)
// so the scenario notices and the mailed samples are read with no node:fs call. The bundled files are the same for
// every world, so one source per isolate is enough. Paths are repo-relative with "/" separators.
import type { FixtureSource } from "../../../contracts/src/ext/cf-platform";

/** The repo-relative directories the notice fixtures live in. */
export const NOTICE_FIXTURE_DIRS = { scenarios: "packages/sim/fixtures/notices", mailed: "packages/sim/src/notices/mailed" } as const;

let source: FixtureSource | null = null;
const listeners = new Set<() => void>();

/** Reads the notice fixtures from `next` (the durable platform), or from the repo files again with null (Node). */
export function useNoticeFixtures(next: FixtureSource | null): void {
  if (next === source) return;
  source = next;
  for (const l of listeners) l();
}
export function noticeFixtureSource(): FixtureSource | null { return source; }
/** Caches drop what they read when the source changes. */
export function onNoticeFixturesChanged(listener: () => void): void { listeners.add(listener); }
