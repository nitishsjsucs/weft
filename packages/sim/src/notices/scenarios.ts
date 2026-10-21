// Notice scenarios (SPEC 8): original fictional fixture text, rendered with the sim date, then parsed. The text comes
// from the repo on Node and from the platform's FixtureSource on the durable platform (./fixtures.ts).
import { NOTICE_FIXTURE_DIRS, noticeFixtureSource, onNoticeFixturesChanged } from "./fixtures";
import type { AgencyCode, AgencyNoticeKind, NoticeExtract, NoticeScenario } from "@weft/contracts";
import { addDays, ptDate } from "../time";
import { parseNotice } from "./parser";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

export interface ScenarioDef { agency: AgencyCode; formCode: string; kind: AgencyNoticeKind; title: string; fileName: string; respondDays: number }

export const SCENARIOS: Readonly<Record<NoticeScenario, ScenarioDef>> = {
  ca_de2088_rate_change: { agency: "ca_edd", formCode: "DE 2088", kind: "rate_change", title: "Revised Notice of Contribution Rates, 2026", fileName: "CA_EDD_DE2088_2026.txt", respondDays: 60 },
  ca_de2088_injection: { agency: "ca_edd", formCode: "DE 2088", kind: "rate_change", title: "Revised Notice of Contribution Rates, 2026", fileName: "CA_EDD_DE2088_2026.txt", respondDays: 60 },
  ny_missing_filing: { agency: "ny_dtf", formCode: "NYS-45", kind: "missing_filing", title: "Quarterly return not received, 2026-Q3", fileName: "NY_DTF_NYS45_2026Q3.txt", respondDays: 30 },
  irs_deposit_schedule_change: { agency: "irs", formCode: "CP136", kind: "deposit_schedule_change", title: "Federal tax deposit schedule for 2027", fileName: "IRS_CP136_2027.txt", respondDays: 30 },
};

const cache = new Map<NoticeScenario, string>();
onNoticeFixturesChanged(() => cache.clear());
export function fixtureText(name: NoticeScenario): string {
  let t = cache.get(name);
  if (t === undefined) {
    const src = noticeFixtureSource();
    if (src) {
      const text = src.text(`${NOTICE_FIXTURE_DIRS.scenarios}/${name}.txt`);
      if (text === null) throw new Error(`notice fixture ${name} is not bundled`);
      t = text;
    } else {
      t = fs().readFileSync(new URL(`../../fixtures/notices/${name}.txt`, import.meta.url), "utf8");
    }
    cache.set(name, t);
  }
  return t;
}

export interface RenderedNotice { agency: AgencyCode; formCode: string; kind: AgencyNoticeKind; title: string; fileName: string; bodyText: string; extracted: NoticeExtract; respondBy: string }

/** Renders a scenario for the sim time `now`: the notice date is today in PT, respond-by is that plus the window. */
export function renderScenarioAt(name: NoticeScenario, now: string): RenderedNotice {
  const def = SCENARIOS[name];
  if (!def) throw new Error(`unknown notice scenario ${String(name)}`);
  const noticeDate = ptDate(now);
  const respondBy = addDays(noticeDate, def.respondDays);
  const bodyText = fixtureText(name).replaceAll("{{NOTICE_DATE}}", noticeDate).replaceAll("{{RESPOND_BY}}", respondBy);
  const extracted = parseNotice({ agency: def.agency, formCode: def.formCode, kind: def.kind, text: bodyText });
  return { agency: def.agency, formCode: def.formCode, kind: def.kind, title: def.title, fileName: def.fileName, bodyText, extracted, respondBy };
}
