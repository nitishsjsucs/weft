// Untrusted content as copy. A run's taint source is stored as `<kind>:<id>` ("chat:simc_0037", "notice:ntc_0007",
// "memory:knowledge/x.md", "mcp"); a person reads where the text came from, not the row id. And a notice body's lines
// that read as instructions to an AI are pointed out, so the audience can see what the agent was never shown.

const KIND: Record<string, string> = {
  chat: "a chat message someone posted",
  notice: "the text of an agency notice",
  worker: "text a person entered on their own record",
  artifact: "a saved result that holds untrusted text",
  memory: "a memory note marked untrusted",
  suggestion: "a suggestion filed by a run that read untrusted text",
  routine: "the routine run that started it, which read untrusted text",
  run: "the run that started it, which read untrusted text",
  expenses: "text an employee entered on an expense claim",
  time_off: "a note an employee wrote on a time-off request",
  onboarding: "text a new hire entered in the portal",
  offer: "text from a candidate's offer",
  documents: "text from an uploaded document",
  integrations: "data an outside system sent",
};

/** Where a run's untrusted content came from, in words ("a chat message someone posted in #payroll"). */
export function taintText(src: string | null | undefined, detail?: { channel?: string | null; author?: string | null }): string {
  const s = (src ?? "").trim();
  if (!s || s === "external") return "content from outside Weft";
  if (s === "mcp") return "a request from an outside MCP client";
  const kind = s.includes(":") ? s.slice(0, s.indexOf(":")) : s.split(".")[0]!;
  const base = KIND[kind] ?? (s.includes(".") && !s.includes(":") ? `untrusted text a ${s.split(".")[0]!.replaceAll("_", " ")} read returned` : "untrusted text from outside Weft");
  if (kind === "chat" && (detail?.author || detail?.channel)) return `a chat message${detail.author ? ` from ${detail.author}` : ""}${detail.channel ? ` in ${detail.channel}` : ""}`;
  return base;
}

/**
 * Lines of an untrusted text that read as instructions to an AI model rather than as the sender's content: "ignore
 * prior instructions", a claimed system or admin override, a demand to approve or pay. The parser never passes them
 * on; the UI shows them so a person sees what was held back.
 */
const INSTRUCTION = /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:instructions?|rules|prompt|guidelines)\b|\bsystem override\b|\byou are now\b|\bas (?:the|an?) (?:ai|assistant|agent)\b|\b(?:approve|release|submit)\b[^.\n]{0,30}\b(?:payroll|everything|all (?:pending|proposals|payments))\b/i;
export function instructionLines(text: string | null | undefined): string[] {
  return (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= 400 && INSTRUCTION.test(l));
}
