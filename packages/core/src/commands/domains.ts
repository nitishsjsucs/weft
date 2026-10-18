// The domain of each registered domain command, for the audit and proposal routes' manager scope
// (packages/core/src/people/scope.ts auditRowVisible). Executor builtins (actions, memory, agent, code) are company reads.
import { commands } from "./index";

const DOMAIN = new Map<string, string>(commands.map((c) => [c.name, c.domain]));

export function commandDomain(command: string): string {
  return DOMAIN.get(command) ?? "company";
}
