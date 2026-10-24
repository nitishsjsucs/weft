"use client";
// The lines of an untrusted text that read as instructions to the agent, shown where a person looks at the notice:
// what was held back, and (when the run is known) whether the agent's run ever read it.
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { instructionLines } from "./untrusted";

export function HeldBack({ text, runRead }: { text: string | null | undefined; runRead?: boolean | null }) {
  const lines = instructionLines(text);
  if (!lines.length) return null;
  const n = lines.length === 1 ? "One line" : `${lines.length} lines`;
  const read = runRead === true;
  return (
    <div data-testid="notice-held-back" data-run-read={runRead === undefined || runRead === null ? "unknown" : String(read)} className={`flex flex-col gap-1.5 rounded-lg px-3 py-2 text-1 ${read ? "bg-amber-3 text-amber-11" : "bg-green-3 text-green-11"}`}>
      <div className="flex items-start gap-1.5">
        {read ? <ShieldAlert className="mt-px size-3.5 shrink-0" /> : <ShieldCheck className="mt-px size-3.5 shrink-0" />}
        <span className="min-w-0 break-words">
          {n} of this notice {lines.length === 1 ? "reads" : "read"} as an instruction to the agent and {lines.length === 1 ? "was" : "were"} held back as untrusted text.{" "}
          {runRead === false ? "The agent's run worked from the parsed fields and never saw it." : read ? "The run read the notice text, so it is marked tainted and every send waits as a proposal." : "The agent works from the parsed fields; a run that reads the text is marked tainted and can only propose."}
        </span>
      </div>
      <details className="text-gray-11">
        <summary className="cursor-pointer select-none text-gray-10">Show the held-back {lines.length === 1 ? "line" : "lines"}</summary>
        <pre data-assist-untrusted="" className="mt-1 rounded-md bg-gray-2 px-2 py-1 font-mono text-0 break-words whitespace-pre-wrap text-gray-12">{lines.join("\n")}</pre>
      </details>
    </div>
  );
}
