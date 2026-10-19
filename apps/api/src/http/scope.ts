// The read scope for routes that read the database directly instead of running a read command (the commands narrow
// themselves through packages/core/src/people/scope.ts). Same rule on every surface: the People and payroll roles
// read every record; anyone else (a manager first) reads full records only for themself and their direct and
// indirect reports, and nothing at all in a domain their grants close (payroll: none closes every payroll read).
import type { Context } from "hono";
import { Forbidden } from "@weft/contracts";
import { hasDomain, readScopeFor, type ReadScope } from "@weft/core";
import type { Weft, WeftEnv } from "./context";

/** The narrowing for the session's person, or null when they read full records. */
export function viewerScope(weft: Weft, c: Context<WeftEnv>): Promise<ReadScope | null> {
  const s = c.var.session;
  return readScopeFor(weft.db, s?.companyId ?? "cmp_larkspur", s?.principalId ?? null);
}

/** Refuses a narrowed person whose grants close `domain`, as the executor refuses the same read as a command. */
export function needDomain(scope: ReadScope | null, domain: string, what: string): void {
  if (scope && !hasDomain(scope, domain)) {
    throw new Forbidden(`${scope.display} cannot view ${what}: the ${domain} domain is not shared with their role`, { code: "NOT_PERMITTED", domain });
  }
}
