// Wave 4 commands (docs/wave4.md, W4_PLANNED_COMMANDS in packages/contracts/src/wave4.ts). Owner: w4-parity-compliance.
// Planned: compliance.*, tax filings (tax.list_filings, tax.prepare_filing, tax.file_return), handoffs.*, training.*, notices.upload and notices.ingest_upload. Append here only; commands/index.ts concatenates it, so the other namespace files stay untouched.
// Honest risk and approval from the planned table, zod inputs with no z.record (strict schemas), preview for anything
// that proposes, access "human_only" for a person's own submissions. Update the registry snapshot test in the same commit.
import type { WeftCommand } from "../shared/deps";

export const w4ComplianceCommands: WeftCommand[] = [];
