// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-admin.
// Planned: routines.gallery, settings.permission_matrix, settings.set_agent_action_override. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
import type { WeftCommand } from "../shared/deps";

export const w4AdminCommands: WeftCommand[] = [];
