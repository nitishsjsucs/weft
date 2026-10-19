// The guided tour's step data and budget math (owner: tour). Pure: no DOM, no React.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budgetHardMs, budgetSoftMs, fill, plannedAfterMs, stepBody, targetCandidates, tourTokens, TOUR_BUDGET_MS, TOUR_CHART_PROMPT,
  TOUR_COPY, TOUR_RESET_COPY, TOUR_STEPS,
} from "../src/components/tour/steps";
import { acceptHit, PRIMARY_GRACE_MS } from "../src/components/tour/dom";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const webSrc = join(repo, "apps/web/src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** Sentences: split on a period, question or exclamation mark followed by a space (so "2.0" and "1.5%" stay whole). */
const DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;

describe("tour steps", () => {
  it("has 21 steps with unique ids in order", () => {
    expect(TOUR_STEPS).toHaveLength(21);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    TOUR_STEPS.forEach((s, i) => expect(s.n).toBe(i + 1));
  });

  it("plans at most 165 s, and at most 180 s with every hard timeout spent in full", () => {
    const planned = TOUR_STEPS.reduce((t, s) => t + s.seconds, 0);
    expect(planned).toBeLessThanOrEqual(165);
    const worst = planned + TOUR_STEPS.reduce((t, s) => t + (s.hardMs ? s.hardMs / 1000 - s.seconds : 0), 0);
    expect(worst).toBeLessThanOrEqual(180);
  });

  it("keeps copy short: bodies at most 2 sentences and 240 characters, titles at most 40", () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.length, s.id).toBeLessThanOrEqual(40);
      expect(s.body.length, s.id).toBeLessThanOrEqual(240);
      expect(sentences(s.body), s.id).toBeLessThanOrEqual(2);
    }
    for (const [k, v] of Object.entries(TOUR_COPY)) expect(sentences(v), k).toBeLessThanOrEqual(2);
  });

  it("uses no em or en dash anywhere in the tour copy or source", () => {
    const all = [...TOUR_STEPS.flatMap((s) => [s.title, s.body, s.proxyLabel ?? ""]), ...Object.values(TOUR_COPY), ...Object.values(TOUR_RESET_COPY)];
    for (const t of all) expect(t).not.toMatch(DASH);
    for (const f of sources(join(webSrc, "components/tour"))) expect(readFileSync(f, "utf8"), f).not.toMatch(DASH);
  });

  it("targets only data-tour tokens, and every token exists in the app source", () => {
    const sels = TOUR_STEPS.flatMap((s) => [s.target, ...(s.fallbacks ?? []), ...(s.secondary ?? []), ...(s.prepare ?? []).flat()]).filter((x): x is string => !!x);
    for (const sel of sels) {
      expect(sel, sel).toMatch(/\[data-tour~="/);
      // Attribute selectors and descendant spaces only: no classes, ids, tags or data-testid.
      expect(sel.replace(/\[data-[\w-]+(?:[~^]?="[^"]*")?\]/g, "").trim(), sel).toBe("");
      expect(sel, sel).not.toMatch(/data-testid/);
    }
    const app = sources(webSrc).filter((f) => !f.includes("/components/tour/")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const token of tourTokens()) expect(app, `data-tour token ${token}`).toContain(`"${token}"`);
  });

  it("asks a chart prompt the scripted chat_payroll_cost scenario matches", () => {
    const scenario = JSON.parse(readFileSync(join(repo, "scenarios/chat_payroll_cost.json"), "utf8")) as { match: string };
    expect(new RegExp(scenario.match, "i").test(TOUR_CHART_PROMPT)).toBe(true);
  });

  it("fills placeholders from the memo and drops a target whose id is unknown", () => {
    const step = TOUR_STEPS.find((s) => s.id === "inbox-proposal")!;
    expect(targetCandidates(step, {})).toEqual(step.fallbacks);
    expect(targetCandidates(step, { rateProposalId: "prp_0003" })[0]).toBe('[data-tour~="inbox-card"][data-proposal-id="prp_0003"]');
    expect(fill("{a}", {})).toBeNull();
    expect(stepBody(TOUR_STEPS.find((s) => s.id === "portal")!, { hireName: "Noor Castellanos (demo)" })).toMatch(/^Noor Castellanos signs/);
  });
});

describe("budget-aware timeouts", () => {
  it("caps a hard timeout by what the steps left need, never below the step's own seconds", () => {
    const i = TOUR_STEPS.findIndex((s) => s.id === "agent-run");
    expect(budgetHardMs(i, 0)).toBe(20_000);
    const late = TOUR_BUDGET_MS - plannedAfterMs(i) - 12_000;
    expect(budgetHardMs(i, late)).toBe(12_000);
    expect(budgetHardMs(i, TOUR_BUDGET_MS)).toBe(10_000);
    expect(budgetSoftMs(i, 0)).toBe(12_000);
    expect(budgetSoftMs(i, late + 3_000)).toBe(10_000);
  });

  it("never lets a full tour run past 180 s, however slow every wait is", () => {
    // Worst case: every step with a hard timeout uses all of it, every other step uses exactly its seconds, starting
    // from any late start the plan still allows.
    for (const slack of [0, 5_000, 10_000, 19_000]) {
      let t = slack;
      TOUR_STEPS.forEach((s, i) => { t += s.hardMs ? budgetHardMs(i, t) : s.seconds * 1000; });
      expect(t, `slack ${slack}`).toBeLessThanOrEqual(TOUR_BUDGET_MS);
    }
  });
});

describe("targets", () => {
  it("takes the step's own selector at once and a fallback only after the grace period", () => {
    const sels = ['[data-tour~="memory-file"][data-path="a.md"]', '[data-tour~="memory-file"]'];
    expect(acceptHit(sels[0]!, sels, 0)).toBe(true);
    expect(acceptHit(sels[1]!, sels, 0)).toBe(false);
    expect(acceptHit(sels[1]!, sels, PRIMARY_GRACE_MS - 1)).toBe(false);
    expect(acceptHit(sels[1]!, sels, PRIMARY_GRACE_MS)).toBe(true);
    expect(acceptHit(null, sels, 10_000)).toBe(false);
    // The grace fits inside the 5 s locate window with room to spare.
    expect(PRIMARY_GRACE_MS).toBeLessThan(5_000);
  });

  it("points the memory step at a file the seed writes", () => {
    const step = TOUR_STEPS.find((s) => s.id === "memory")!;
    const path = /data-path="([^"]+)"/.exec(step.target ?? "")?.[1];
    expect(path).toBeTruthy();
    const seed = readFileSync(join(repo, "packages/executor/src/memory/seed-content.ts"), "utf8");
    expect(seed).toContain(`path: "${path}"`);
    expect(step.route).toEqual({ kind: "path", path: `/app/memory#${encodeURIComponent(path!)}` });
    expect(step.prepare?.[0]?.[0]).toContain(`data-path="${path}"`);
  });
});
