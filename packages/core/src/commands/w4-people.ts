// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-people.
// Planned: benefits life events, windows and carrier submissions, people.out_this_week, comms.send_first_day_message. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
import type { WeftCommand } from "../shared/deps";

export const w4PeopleCommands: WeftCommand[] = [];
