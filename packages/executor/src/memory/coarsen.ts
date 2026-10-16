// Timeline coarsening (harness 18 item 1): timeline/raw/YYYY-MM-DD.md rolls into hourly, daily, weekly and monthly
// summaries on the sim clock. Pure and deterministic: the same raw files and clock give the same summaries, so a
// second digest for a period is a no-op. Only closed periods are summarised. Each summary lists event counts by
// kind, the importance 2 and 3 events verbatim, and path#L<n> back-references. Weekly and monthly summaries are
// built from the daily ones, so they survive the raw files leaving the working tree.
import type { CoarsenLevel, MemoryFrontmatter } from "@weft/contracts";
import { extractLinks } from "./links";

export const RAW_WINDOW_DAYS = 7;
export const MAX_REFS_PER_KIND = 5;

export interface RawEvent { at: string; importance: number; command: string; line: string; ref: string }
export interface Period { level: CoarsenLevel; key: string; start: string; end: string; path: string }
export interface SummaryDoc { path: string; frontmatter: MemoryFrontmatter; body: string }
export interface CoarsenPlan { writes: SummaryDoc[]; removes: string[]; periods: Period[] }

const RAW_LINE = /^- (\d{4}-\d{2}-\d{2}T[0-9:.]+Z) \[i([0-3])\] ([A-Za-z0-9_.]+): /;

/** Raw events of one raw file, with 1-based line numbers counted over the whole file (frontmatter included). */
export function parseRaw(path: string, text: string): RawEvent[] {
  const out: RawEvent[] = [];
  text.split("\n").forEach((l, i) => {
    const m = RAW_LINE.exec(l);
    if (m) out.push({ at: m[1]!, importance: Number(m[2]), command: m[3]!, line: l.slice(2), ref: `${path}#L${i + 1}` });
  });
  return out;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** ISO 8601 week key (2026-W41) and its Monday, in UTC. */
export function isoWeek(day: string): { key: string; monday: string } {
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dow * DAY_MS);
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS);
  const n = Math.round((monday.getTime() - week1.getTime()) / (7 * DAY_MS)) + 1;
  return { key: `${year}-W${String(n).padStart(2, "0")}`, monday: isoDay(monday.getTime()) };
}

export function periodOf(level: CoarsenLevel, at: string): Period {
  const day = at.slice(0, 10);
  if (level === "hourly") {
    const h = at.slice(11, 13);
    const start = `${day}T${h}:00:00.000Z`;
    return { level, key: `${day}T${h}`, start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), path: `timeline/hourly/${day}T${h}.md` };
  }
  if (level === "daily") {
    const start = `${day}T00:00:00.000Z`;
    return { level, key: day, start, end: new Date(Date.parse(start) + DAY_MS).toISOString(), path: `timeline/daily/${day}.md` };
  }
  if (level === "weekly") {
    const w = isoWeek(day);
    const start = `${w.monday}T00:00:00.000Z`;
    return { level, key: w.key, start, end: new Date(Date.parse(start) + 7 * DAY_MS).toISOString(), path: `timeline/weekly/${w.key}.md` };
  }
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  return { level, key: day.slice(0, 7), start, end: new Date(Date.UTC(y, m, 1)).toISOString(), path: `timeline/monthly/${day.slice(0, 7)}.md` };
}

const closed = (p: Period, now: string) => Date.parse(p.end) <= Date.parse(now);

interface Rollup { counts: Map<string, { n: number; refs: string[] }>; important: string[]; links: Set<string>; total: number; sources: Set<string> }

function emptyRollup(): Rollup { return { counts: new Map(), important: [], links: new Set(), total: 0, sources: new Set() }; }

function addEvent(r: Rollup, e: RawEvent) {
  r.total += 1;
  const c = r.counts.get(e.command) ?? { n: 0, refs: [] };
  c.n += 1;
  if (c.refs.length < MAX_REFS_PER_KIND) c.refs.push(e.ref);
  r.counts.set(e.command, c);
  if (e.importance >= 2) r.important.push(`${e.line} (ref: ${e.ref})`);
  for (const l of extractLinks(e.line)) r.links.add(l);
  r.sources.add(e.ref.split("#")[0]!);
}

const TITLES: Record<CoarsenLevel, string> = { hourly: "Hourly summary", daily: "Daily summary", weekly: "Weekly summary", monthly: "Monthly summary" };

function render(p: Period, r: Rollup, note: string | null): SummaryDoc {
  const kinds = [...r.counts.keys()].sort();
  const counts = kinds.map((k) => {
    const c = r.counts.get(k)!;
    const more = c.n > c.refs.length ? ` and ${c.n - c.refs.length} more` : "";
    return `- ${k}: ${c.n} (${c.refs.join(", ")}${more})`;
  });
  const body = [
    `# ${TITLES[p.level]} ${p.key}`, "",
    `Events: ${r.total}. Period ${p.start} to ${p.end}.${note ? ` ${note}` : ""}`, "",
    "## Counts by kind", "", ...(counts.length ? counts : ["- none"]), "",
    "## Importance 2 and 3 events", "", ...(r.important.length ? r.important.map((l) => `- ${l}`) : ["- none"]), "",
    "## Back-references", "", ...[...r.sources].sort().map((s) => `- ${s}`), "",
  ].join("\n");
  return {
    path: p.path, body,
    frontmatter: { id: `timeline-${p.level}-${p.key}`, type: `timeline_${p.level}` as MemoryFrontmatter["type"], aliases: [], links: [...r.links].sort(),
      sources: [...r.sources].sort(), status: null, updated: p.start.slice(0, 10), taintedBy: null },
  };
}

/** Reads a daily summary back into a rollup (weekly and monthly are built from dailies, not from raw). */
export function parseDaily(path: string, body: string): Rollup {
  const r = emptyRollup();
  let section = "";
  for (const l of body.split("\n")) {
    if (l.startsWith("## ")) { section = l; continue; }
    if (!l.startsWith("- ") || l === "- none") continue;
    if (section === "## Counts by kind") {
      const m = /^- ([A-Za-z0-9_.]+): (\d+) \(([^)]*)\)/.exec(l);
      if (!m) continue;
      const refs = m[3]!.replace(/ and \d+ more$/, "").split(", ").filter(Boolean);
      const c = r.counts.get(m[1]!) ?? { n: 0, refs: [] };
      c.n += Number(m[2]);
      for (const ref of refs) if (c.refs.length < MAX_REFS_PER_KIND) c.refs.push(ref);
      r.counts.set(m[1]!, c);
      r.total += Number(m[2]);
    } else if (section === "## Importance 2 and 3 events") {
      r.important.push(l.slice(2));
      for (const x of extractLinks(l)) r.links.add(x);
    }
  }
  r.sources.add(path);
  return r;
}

function merge(into: Rollup, r: Rollup) {
  for (const [k, c] of r.counts) {
    const t = into.counts.get(k) ?? { n: 0, refs: [] };
    t.n += c.n;
    for (const ref of c.refs) if (t.refs.length < MAX_REFS_PER_KIND) t.refs.push(ref);
    into.counts.set(k, t);
  }
  into.important.push(...r.important);
  for (const l of r.links) into.links.add(l);
  for (const s of r.sources) into.sources.add(s);
  into.total += r.total;
}

/**
 * Plans one digest: summaries for every closed hour and day that has raw events, every closed week and month that
 * has dailies, and the raw files past the window (whose daily summary is in this plan or already present).
 * `rawCommit` names the commit where removed raw files can still be read, so back-references stay resolvable.
 */
export function planCoarsen(input: { now: string; raw: { path: string; text: string }[]; daily: { path: string; body: string }[]; windowDays?: number; rawCommit?: string | null }): CoarsenPlan {
  const window = input.windowDays ?? RAW_WINDOW_DAYS;
  const writes = new Map<string, SummaryDoc>();
  const periods: Period[] = [];
  const hourly = new Map<string, { p: Period; r: Rollup }>();
  const daily = new Map<string, { p: Period; r: Rollup }>();
  for (const f of [...input.raw].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const e of parseRaw(f.path, f.text)) {
      for (const [level, map] of [["hourly", hourly], ["daily", daily]] as const) {
        const p = periodOf(level, e.at);
        if (!closed(p, input.now)) continue;
        if (!map.has(p.key)) map.set(p.key, { p, r: emptyRollup() });
        addEvent(map.get(p.key)!.r, e);
      }
    }
  }
  // Raw files past the window leave the working tree in this digest (git history keeps them); their day's
  // summaries name the commit where the back-references still resolve. Days inside the window carry no note, so
  // re-running the digest over them changes nothing.
  const cutoff = Date.parse(input.now) - window * DAY_MS;
  const removes = input.raw.map((f) => f.path).filter((path) => {
    const day = /timeline\/raw\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1];
    return Boolean(day) && Date.parse(`${day}T00:00:00.000Z`) + DAY_MS <= cutoff;
  }).sort();
  const leaving = new Set(removes.map((p) => p.slice("timeline/raw/".length, -3)));
  const note = (p: Period) => input.rawCommit && leaving.has(p.start.slice(0, 10)) ? `Raw back-references resolve at commit ${input.rawCommit}.` : null;
  for (const map of [hourly, daily]) {
    for (const k of [...map.keys()].sort()) { const { p, r } = map.get(k)!; writes.set(p.path, render(p, r, note(p))); periods.push(p); }
  }
  // Weekly and monthly from the daily summaries (existing ones plus the ones planned now).
  const dailies = new Map(input.daily.map((d) => [d.path, d.body]));
  for (const [path, doc] of writes) if (doc.frontmatter.type === "timeline_daily") dailies.set(path, doc.body);
  for (const level of ["weekly", "monthly"] as const) {
    const groups = new Map<string, { p: Period; r: Rollup }>();
    for (const path of [...dailies.keys()].sort()) {
      const day = /timeline\/daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1];
      if (!day) continue;
      const p = periodOf(level, `${day}T00:00:00.000Z`);
      if (!closed(p, input.now)) continue;
      if (!groups.has(p.key)) groups.set(p.key, { p, r: emptyRollup() });
      merge(groups.get(p.key)!.r, parseDaily(path, dailies.get(path)!));
    }
    for (const k of [...groups.keys()].sort()) { const { p, r } = groups.get(k)!; writes.set(p.path, render(p, r, null)); periods.push(p); }
  }
  return { writes: [...writes.values()], removes, periods };
}

/** The run key of a digest: the closed periods it covers, so a repeat for the same periods is recognisable. */
export function digestKey(periods: Period[]): string {
  return periods.map((p) => `${p.level}:${p.key}`).sort().join(",");
}
