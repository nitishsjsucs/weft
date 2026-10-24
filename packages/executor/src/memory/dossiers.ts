// Dossiers and the company one-pager (harness 18 item 3): entities hold current state, the timeline holds history.
// Pure renderers over structured rows the digest passes in. Work-relevant facts only, each dated and sourced; no
// pay amounts, no inferred traits, and never a fact marked tainted (untrusted text never enters a dossier).
import type { MemoryFrontmatter } from "@weft/contracts";
import { RECALL_BUDGET } from "@weft/contracts";
import { approvalsDoc, type DecisionRow } from "./preferences";
import { companyDay, humanTimes } from "./time";

export const ONE_PAGER_PATH = RECALL_BUDGET.onePager;
export const MAX_ONE_PAGER_ITEMS = 8;

export interface DossierFact { text: string; date: string; src: string; tainted?: boolean }
export interface DossierDoc { subjectRef: string | null; path: string; frontmatter: MemoryFrontmatter; body: string; facts: { text: string; sourceRef: string }[] }

export interface PersonInput { id: string; name: string; aliases: string[]; facts: DossierFact[] }
export interface StateInput { code: string; facts: DossierFact[] }
export interface AgencyInput { id: string; path: string; name: string; aliases: string[]; facts: DossierFact[] }
export interface NoticeInput { id: string; facts: DossierFact[] }
export interface OnePagerInput {
  companyName: string; asOf: string;
  headcount: DossierFact[]; openItems: DossierFact[]; workstreams: DossierFact[]; autonomy: DossierFact[];
}
export interface DigestSources { people: PersonInput[]; states: StateInput[]; agencies: AgencyInput[]; notices: NoticeInput[]; onePager: OnePagerInput | null; decisions?: DecisionRow[] }

/** One line, no wiki-link brackets, never a money amount (dossiers hold no pay data), and times in company time. */
const clean = (s: string) => humanTimes(s.replace(/\s+/g, " ").replace(/[[\]]/g, "").replace(/\$\s?\d[\d,]*(\.\d+)?/g, "[amount]").trim());
const bullet = (f: DossierFact) => `- ${clean(f.text)} (${companyDay(f.date)}, src: ${f.src})`;
const trusted = (facts: DossierFact[]) => facts.filter((f) => !f.tainted);
const latest = (facts: DossierFact[], fallback: string) => facts.map((f) => companyDay(f.date)).sort().at(-1) ?? fallback;

function doc(subjectRef: string | null, path: string, type: MemoryFrontmatter["type"], id: string, aliases: string[], title: string, facts: DossierFact[], fallbackDate: string): DossierDoc {
  const kept = trusted(facts).slice(0, 40);
  const body = `# ${title}\n\n${kept.length ? kept.map(bullet).join("\n") : "- No current facts (" + fallbackDate + ", src: digest)"}\n`;
  return {
    subjectRef, path, body, facts: kept.map((f) => ({ text: clean(f.text), sourceRef: f.src })),
    frontmatter: { id, type, aliases: [...new Set(aliases)].sort(), links: [], sources: [...new Set(kept.map((f) => f.src))].sort(), status: null, updated: latest(kept, fallbackDate), taintedBy: null },
  };
}

export function personDossier(p: PersonInput, fallbackDate: string): DossierDoc {
  return doc(p.id, `entities/people/${p.id}.md`, "person", p.id, p.aliases, clean(p.name), p.facts, fallbackDate);
}

export function stateDossier(s: StateInput, fallbackDate: string): DossierDoc {
  return doc(null, `entities/states/${s.code}.md`, "fact", `state-${s.code}`, [s.code], `${s.code} (work state)`, s.facts, fallbackDate);
}

export function agencyDossier(a: AgencyInput, fallbackDate: string): DossierDoc {
  return doc(a.id, a.path, "agency", a.id, a.aliases, clean(a.name), a.facts, fallbackDate);
}

export function noticeDossier(n: NoticeInput, fallbackDate: string): DossierDoc {
  return doc(n.id, `entities/notices/${n.id}.md`, "fact", n.id, [n.id], `Notice ${n.id}`, n.facts, fallbackDate);
}

/** knowledge/company/one-pager.md: headcount by state, open items, active workstreams, the agent's autonomy settings. */
export function onePager(o: OnePagerInput, companyRef: string): DossierDoc {
  const section = (title: string, facts: DossierFact[]) => {
    const kept = trusted(facts);
    const shown = kept.slice(0, MAX_ONE_PAGER_ITEMS).map(bullet);
    if (kept.length > MAX_ONE_PAGER_ITEMS) shown.push(`- and ${kept.length - MAX_ONE_PAGER_ITEMS} more (${o.asOf}, src: digest)`);
    const hidden = facts.length - kept.length;
    if (hidden > 0) shown.push(`- ${hidden} item${hidden === 1 ? "" : "s"} from untrusted sources left out (${o.asOf}, src: digest)`);
    return [`## ${title}`, "", ...(shown.length ? shown : [`- none (${o.asOf}, src: digest)`]), ""];
  };
  const body = [
    `# ${clean(o.companyName)} one-pager`, "",
    ...section("Headcount by state", o.headcount), ...section("Open items", o.openItems),
    ...section("Active workstreams", o.workstreams), ...section("Agent autonomy", o.autonomy),
  ].join("\n");
  const all = trusted([...o.headcount, ...o.openItems, ...o.workstreams, ...o.autonomy]);
  return {
    subjectRef: companyRef, path: ONE_PAGER_PATH, body, facts: all.slice(0, 40).map((f) => ({ text: clean(f.text), sourceRef: f.src })),
    frontmatter: { id: "company-one-pager", type: "company", aliases: ["one-pager", clean(o.companyName)], links: [], sources: [...new Set(all.map((f) => f.src))].sort(), status: null, updated: o.asOf, taintedBy: null },
  };
}

/** Every dossier the digest writes, in a stable order. */
export function renderDossiers(s: DigestSources, fallbackDate: string, companyRef: string): DossierDoc[] {
  const out: DossierDoc[] = [
    ...[...s.people].sort((a, b) => a.id.localeCompare(b.id)).map((p) => personDossier(p, fallbackDate)),
    ...[...s.states].sort((a, b) => a.code.localeCompare(b.code)).map((x) => stateDossier(x, fallbackDate)),
    ...[...s.agencies].sort((a, b) => a.path.localeCompare(b.path)).map((a) => agencyDossier(a, fallbackDate)),
    ...[...s.notices].sort((a, b) => a.id.localeCompare(b.id)).map((n) => noticeDossier(n, fallbackDate)),
  ];
  if (s.onePager) out.push(onePager(s.onePager, companyRef));
  const prefs = approvalsDoc(s.decisions ?? [], fallbackDate);
  if (prefs) out.push(prefs);
  return out;
}
