// The domain of each registered domain command, for the audit and proposal routes' manager scope
// (packages/core/src/people/scope.ts auditRowVisible). Executor builtins (actions, memory, agent, code) are company reads.
import { auditRowVisible, type ReadScope } from "../people/scope";
import { commands } from "./index";

const DOMAIN = new Map<string, string>(commands.map((c) => [c.name, c.domain]));

export function commandDomain(command: string): string {
  return DOMAIN.get(command) ?? "company";
}

/**
 * A proposal a narrowed viewer (a manager) may read: the proposals routes' list and detail rule, shared so every path
 * that shows a proposal (the cursor assistant's approval card and its trace too) narrows it the same way.
 */
export function proposalVisible(scope: ReadScope | null, p: { command: string | null; domain: string | null; argsJson: unknown; subjectRef: string | null; headline: string; diffJson: unknown }): boolean {
  return auditRowVisible(scope, (cmd) => p.domain ?? commandDomain(cmd), { command: p.command, argsJson: p.argsJson, subjectRef: p.subjectRef, text: `${p.headline} ${p.diffJson ?? ""}` });
}
