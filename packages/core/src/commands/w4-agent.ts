// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-agent.
// Planned: portal.* self-scope reads, expenses.intake_email, agent.record_mention, routines.open_wait, routines.resume_wait, routines.list_waits. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
// Landed: the five portal.* reads (R0, no worker id argument), portal.request_handoff (human only, the employee's own
// request for a person; additive to the planned table), agent.record_mention and expenses.intake_email (system only).
import type { WeftCommand } from "../shared/deps";
import { portalCommandsW4 } from "../agent-surfaces/portal";
import { recordMention } from "../agent-surfaces/mentions";
import { intakeEmail } from "../agent-surfaces/intake";

export const w4AgentCommands: WeftCommand[] = [...portalCommandsW4, recordMention, intakeEmail];
