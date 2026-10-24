"use client";
// A chat answer on screen: the safe Markdown subset from parseAnswer as React nodes (never HTML from the model, never a
// link it wrote), with each cited result as a small numbered chip that opens the run's trace.
import Link from "next/link";
import { Fragment } from "react";
import { parseAnswer, type AnswerSpan } from "./answer";

function Span({ s, runId, cites }: { s: AnswerSpan; runId: string; cites: string[] }) {
  if (s.t === "b") return <strong className="font-semibold">{s.s}</strong>;
  if (s.t === "code") return <code className="rounded bg-gray-3 px-1 font-mono text-[12px]">{s.s}</code>;
  if (s.t === "cite") {
    return (
      <Link href={`/app/runs/${runId}${cites[s.n - 1] ? `#${cites[s.n - 1]}` : ""}`} data-testid="agent-answer-cite" data-cite={cites[s.n - 1]} aria-label={`Source ${s.n}: a tool result in this run`} title="Open the tool result this rests on"
        className="mx-px inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded-full bg-gray-3 px-1 align-middle font-mono text-[10px] leading-none text-gray-11 no-underline hover:bg-gray-4 hover:text-foreground">{s.n}</Link>
    );
  }
  return <>{s.s}</>;
}

/**
 * `untrusted`: the answer of a run that read untrusted content (run.tainted). Its words were written after that read,
 * so the cursor assistant's screen map reads them as text people typed ([data-assist-untrusted]), never as the app's.
 */
export function AnswerView({ text, runId, testId, untrusted = false }: { text: string; runId: string; testId?: string; untrusted?: boolean }) {
  const { blocks, cites } = parseAnswer(text);
  return (
    <div data-testid={testId} data-assist-untrusted={untrusted ? "" : undefined} className="flex flex-col gap-2 text-2 leading-[22px] break-words text-gray-12">
      {blocks.map((b, i) => b.kind === "ul" ? (
        <ul key={i} className="flex list-disc flex-col gap-0.5 pl-5">
          {b.items.map((spans, j) => <li key={j}>{spans.map((s, k) => <Span key={k} s={s} runId={runId} cites={cites} />)}</li>)}
        </ul>
      ) : (
        <p key={i} className="whitespace-pre-wrap">{b.items.map((spans, j) => <Fragment key={j}>{spans.map((s, k) => <Span key={k} s={s} runId={runId} cites={cites} />)}</Fragment>)}</p>
      ))}
    </div>
  );
}
