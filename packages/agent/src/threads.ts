// Conversation threads (the Agent page; packages/contracts/src/ext/agent-page.ts). A follow-up in a thread gets the
// thread's earlier turns as prior conversation in its context pack: at most THREAD_PRIOR_TURNS of the most recent, each
// the person's question and the agent's final answer text, THREAD_PRIOR_CHARS characters in all. apps/api chooses the
// turns (never a tainted run, never a tool result: harness 6.2) and this module only shapes and bounds them. Pure.
import { THREAD_PRIOR_CHARS, THREAD_PRIOR_TURNS } from "../../contracts/src/ext/agent-page";
import { escapeTagText } from "./canonical";

/** One earlier turn: the person's own question and the agent's final answer, as stored. */
export interface EarlierTurn { question: string; answer: string }

const unescapeTagText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The question a chat pack carries (its one <request> block; everything inside the pack is escaped), or null. */
export function questionOfPack(pack: string | null | undefined): string | null {
  const m = /<request>([\s\S]*?)<\/request>/.exec(pack ?? "");
  const q = m ? unescapeTagText(m[1]!).trim() : "";
  return q ? q : null;
}

const CITE = String.raw`\b(?:res|art)_[A-Za-z0-9]+\b`;
/** A parenthetical that only points at results: "(res_0041)", "(results res_1, res_2)", "(source: `art_ab`)". */
const ONLY_CITES = new RegExp(String.raw`\s*\((?:\s*(?:results?|sources?|see|ids?|from)\s*:?\s*)?(?:\x60?${CITE}\x60?(?:\s*(?:,|;|and)\s*)?)+\)`, "gi");

/**
 * An earlier answer as a follow-up reads it: its prose only. The grounded receipt's "What I read:" list (tool result
 * summaries) is left out, and so are the result ids it cited, which name nothing in the new run.
 */
export function answerForThread(summary: string | null | undefined): string {
  let t = (summary ?? "").replace(/\r\n/g, "\n");
  const receipt = t.search(/(?:^|\n)What I read:\s*\n/);
  if (receipt >= 0) t = t.slice(0, receipt);
  t = t.replace(ONLY_CITES, "").replace(new RegExp(String.raw`\x60?${CITE}\x60?`, "g"), "");
  return t.split("\n").map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MARK = " [shortened]";
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= MARK.length) return "";
  return s.slice(0, max - MARK.length).trimEnd() + MARK;
}

/** Longest question and answer kept from one turn, before the shared budget. */
export const TURN_QUESTION_CHARS = 400;
export const TURN_ANSWER_CHARS = 900;
/** A turn with less room than this left for its answer is not worth a place; older turns stop there. */
const MIN_ANSWER_ROOM = 80;

/**
 * The turns a follow-up reads, oldest first: the most recent `maxTurns`, each clipped, newest first into a budget of
 * `maxChars` characters of question and answer text in all, so the latest turn is never the one left out.
 */
export function boundTurns(turns: readonly EarlierTurn[], maxTurns = THREAD_PRIOR_TURNS, maxChars = THREAD_PRIOR_CHARS): EarlierTurn[] {
  const out: EarlierTurn[] = [];
  let left = maxChars;
  for (const t of turns.slice(-Math.max(0, maxTurns)).reverse()) {
    const question = clip(t.question.trim(), Math.min(TURN_QUESTION_CHARS, left - MIN_ANSWER_ROOM));
    if (!question) break;
    const answer = clip(t.answer.trim(), Math.min(TURN_ANSWER_CHARS, left - question.length));
    if (t.answer.trim() && !answer) break;
    out.push({ question, answer });
    left -= question.length + answer.length;
  }
  return out.reverse();
}

/**
 * The <earlier_conversation> block for the context pack, or "" when there is nothing to add. Every question and answer
 * is escaped like the rest of the pack, so nothing in them can open or close a tag; the block names no other tag.
 */
export function earlierConversationBlock(turns: readonly EarlierTurn[]): string {
  const kept = boundTurns(turns);
  if (kept.length === 0) return "";
  const body = kept.map((t, i) => `<turn n="${i + 1}">\n<question>${escapeTagText(t.question)}</question>\n<answer>${escapeTagText(t.answer)}</answer>\n</turn>`);
  return [
    `<earlier_conversation turns="${kept.length}">`,
    "Earlier turns of this conversation with the same person, oldest first, for context only. They are not tool results: read the records again before you state a figure from them. The current request follows this block.",
    ...body,
    "</earlier_conversation>",
  ].join("\n");
}
