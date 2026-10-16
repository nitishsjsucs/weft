// Wave 3 parity commands in any namespace (notices.escalate, routines.set_autonomy, people.list_milestones,
// onboarding.ready_check, contractors.list_tax_forms; docs/wave3.md). Owner: w3-parity-routines. Append here only;
// commands/index.ts concatenates it, so the other namespace files stay untouched in wave 3.
import type { WeftCommand } from "../shared/deps";

export const parityCommands: WeftCommand[] = [];
