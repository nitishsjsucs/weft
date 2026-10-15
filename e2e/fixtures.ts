// E2E harness for the golden paths (SPEC 12, 13). Owner: t6-site.
//
// Every test gets `weft`, a small client for the /v1 API that goes through the web app's /api proxy (the same
// path the browser uses, so the proxy injects x-weft-proxy), and an automatic fixture that calls
// POST /v1/sim/reset before the test and checks the clock is back at the seed time. Specs drive the browser for
// every action a person takes and use the API only to read exact values back (cents, statuses, ids).
import { test as base, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TID, tid } from "../packages/contracts/src/testids";
import type {
  Action, AgentRunRow, ChainStatus, ChatMessage, EmployerRate, MemoryHit, Notice, Offer, PageResult, Paycheck, PayrollRun,
  Proposal, ProposalStatus, RoutineDef, RoutineRunDto, Stats, TaxAccount, Worker,
} from "../packages/contracts/src/index";

export { expect, TID, tid };
export type { Action, AgentRunRow, EmployerRate, Notice, Paycheck, PayrollRun, Proposal, RoutineDef, RoutineRunDto, TaxAccount, Worker };

/** Seeded facts the golden paths rely on (SPEC 5). */
export const SEED = {
  now: "2026-10-26T15:30:00.000Z",           // Monday 08:30 PT
  draftRun: "pay_2026_10_30",
  noorOffer: "offr_0001",
  noorName: "Noor Castellanos (demo)",
  digestRoutine: "rt_people_digest",
  caAccount: "000-4817-2",
  caWorkers: 22,
  caUnderWageBase: 3,
  needsReview: 4,
  ready: 44,
  includedAfterExclude: 47,
} as const;

/**
 * The three demo humans. Principal ids follow the seed convention `usr_<first name>`; override with
 * WEFT_E2E_PRINCIPAL_<NAME> if the governance seed names them differently.
 */
export const PEOPLE = {
  dana: { id: process.env.WEFT_E2E_PRINCIPAL_DANA ?? "usr_dana", name: "Dana Whitfield (demo)", first: "Dana" },
  theo: { id: process.env.WEFT_E2E_PRINCIPAL_THEO ?? "usr_theo", name: "Theo Marsh (demo)", first: "Theo" },
  sam: { id: process.env.WEFT_E2E_PRINCIPAL_SAM ?? "usr_sam", name: "Sam Okafor (demo)", first: "Sam" },
} as const;
export type Person = keyof typeof PEOPLE;

/** Slugs for the Simulators panel clock buttons: `sim-advance-<step>`. */
export const SIM_STEP = { thirtyMinutes: "30m", oneDay: "1d", nextEvent: "next" } as const;

type Query = Record<string, string | number | boolean | undefined | null>;

export class WeftApi {
  constructor(private readonly request: APIRequestContext, readonly principal: string = PEOPLE.dana.id) {}

  as(person: Person): WeftApi { return new WeftApi(this.request, PEOPLE[person].id); }

  private url(path: string, query: Query = {}): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const s = qs.toString();
    return `/api${path}${s ? `?${s}` : ""}`;
  }

  private headers(): Record<string, string> { return { accept: "application/json", "x-weft-principal": this.principal }; }

  async get<T>(path: string, query?: Query): Promise<T> {
    const res = await this.request.get(this.url(path, query), { headers: this.headers() });
    const text = await res.text();
    if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async post<T>(path: string, body?: unknown, timeout = 30_000): Promise<T> {
    const res = await this.request.post(this.url(path), { headers: { ...this.headers(), "content-type": "application/json" }, data: body ?? {}, timeout });
    const text = await res.text();
    if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Every item of a cursor-paged list (SPEC 10: `{ hasMore, count, data }`, `afterId`). */
  async all<T extends object>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.get<PageResult<T>>(path, { ...query, limit: 100, afterId });
      out.push(...r.data);
      if (!r.hasMore || r.data.length === 0) break;
      const last = r.data[r.data.length - 1] as { id?: string; seq?: number };
      afterId = String(last.id ?? last.seq);
    }
    return out;
  }

  // Demo controls -------------------------------------------------------------------------------------------
  async reset(): Promise<void> {
    const r = await this.post<{ ok: boolean }>("/v1/sim/reset", {}, 20_000);
    expect(r.ok, "POST /v1/sim/reset returns { ok: true }").toBe(true);
  }
  clock() { return this.get<{ now: string; rate: number }>("/v1/sim/clock"); }
  advanceClock(body: { to: string } | { by: string } | { toNext: "cron" }) { return this.post<{ now: string; rate: number }>("/v1/sim/clock/advance", body); }

  // Reads used for exact assertions ----------------------------------------------------------------------------
  stats() { return this.get<Stats>("/v1/stats"); }
  proposals(status?: ProposalStatus) { return this.all<Proposal>("/v1/proposals", { status }); }
  proposal(id: string) { return this.get<Proposal>(`/v1/proposals/${id}`); }
  payroll(id: string) { return this.get<PayrollRun>(`/v1/payrolls/${id}`); }
  payrolls() { return this.all<PayrollRun>("/v1/payrolls"); }
  paychecks(runId: string) { return this.all<Paycheck>(`/v1/payrolls/${runId}/paychecks`); }
  rates(jurisdiction?: string) { return this.get<EmployerRate[]>("/v1/tax/rates", { jurisdiction }); }
  taxAccounts() { return this.get<TaxAccount[]>("/v1/tax/accounts"); }
  notices() { return this.all<Notice>("/v1/notices"); }
  notice(id: string) { return this.get<Notice>(`/v1/notices/${id}`); }
  actions() { return this.all<Action>("/v1/actions"); }
  chain() { return this.get<ChainStatus>("/v1/actions/verify"); }
  workers(query: Query = {}) { return this.all<Worker>("/v1/workers", query); }
  offers() { return this.all<Offer>("/v1/offers"); }
  routines() { return this.get<RoutineDef[]>("/v1/routines"); }
  routineRuns(id: string) { return this.all<RoutineRunDto>(`/v1/routines/${id}/runs`); }
  agentRuns() { return this.all<AgentRunRow>("/v1/agent/runs"); }
  chat(channel: string) { return this.get<ChatMessage[]>("/v1/sim/chat", { channel }); }
  memorySearch(q: string) { return this.get<MemoryHit[]>("/v1/memory/search", { q }); }
}

// Page helpers ------------------------------------------------------------------------------------------------

/** Elements whose test id starts with `prefix`, for parameterized ids whose suffix the test learns later. */
export const byTidPrefix = (scope: Page | Locator, prefix: string): Locator => scope.locator(`[data-testid^="${prefix}"]`);

/** A chat channel feed; tolerates the channel name with or without its leading '#'. */
export const chatChannel = (page: Page, channel: string): Locator => {
  const bare = channel.replace(/^#/, "");
  return page.locator(`[data-testid="${tid.chatChannel(bare)}"], [data-testid="${tid.chatChannel(`#${bare}`)}"]`).first();
};

/** Opens an app route and waits for the shell (the sim clock chip renders once the shell has data). */
export async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId(TID.simClock)).toBeVisible();
}

/** Switches the "Viewing as" demo control to one of the three demo humans and checks it took. */
export async function viewAs(page: Page, person: Person): Promise<void> {
  const who = PEOPLE[person];
  const control = page.getByTestId(TID.viewingAs);
  await expect(control).toBeVisible();
  const tag = await control.evaluate((el) => el.tagName);
  if (tag === "SELECT") {
    const labels = await control.locator("option").allTextContents();
    const label = labels.find((l) => l.includes(who.first));
    if (!label) throw new Error(`"Viewing as" has no option for ${who.first}: ${labels.join(", ")}`);
    await control.selectOption({ label });
    await expect(control.locator("option:checked")).toContainText(who.first);
  } else {
    await control.click();
    const option = page.getByRole("menuitemradio", { name: new RegExp(who.first) })
      .or(page.getByRole("option", { name: new RegExp(who.first) }))
      .or(page.getByRole("menuitem", { name: new RegExp(who.first) }));
    await option.first().click();
    await expect(control).toContainText(who.first);
  }
}

/** Makes sure the agent panel is open (it may start collapsed on narrow layouts). */
export async function openAgentPanel(page: Page): Promise<Locator> {
  const composer = page.getByTestId(TID.agentComposer);
  if (!(await composer.isVisible())) {
    const toggle = page.getByRole("button", { name: /agent panel/i });
    await (await toggle.count() ? toggle : page.getByRole("button", { name: /agent/i })).first().click();
  }
  await expect(composer).toBeVisible();
  return composer;
}

/** Sends one message from the agent panel and waits until the answer has settled. */
export async function askAgent(page: Page, text: string): Promise<Locator> {
  const composer = await openAgentPanel(page);
  const before = await page.getByTestId(TID.agentAnswer).count();
  await composer.fill(text);
  await page.getByTestId(TID.agentSend).click();
  const answer = page.getByTestId(TID.agentAnswer).nth(before);
  await expect(answer).toBeVisible();
  await expect(page.getByTestId(TID.agentStatus)).not.toHaveText(/working|running|thinking/i);
  return answer;
}

/** Clicks a proposal card's Approve and waits for the API to show it decided. */
export async function approveCard(page: Page, weft: WeftApi, proposalId: string): Promise<Proposal> {
  const card = page.getByTestId(tid.inboxCard(proposalId));
  await expect(card).toBeVisible();
  await card.getByTestId(TID.inboxApprove).click();
  let decided: Proposal | null = null;
  await expect.poll(async () => (decided = await weft.proposal(proposalId)).status, { message: `proposal ${proposalId} is decided` })
    .toMatch(/^(approved|executed)$/);
  return decided!;
}

/** Sum of one tax line code (for example "sui") paid by the employer on a paycheck, in cents. */
export function employerTaxCents(p: Paycheck, code: string, jurisdiction?: string): number {
  return p.taxes
    .filter((t) => t.payer === "employer" && t.code.toLowerCase() === code.toLowerCase() && (!jurisdiction || t.jurisdiction === jurisdiction))
    .reduce((s, t) => s + t.amountCents, 0);
}

/** Polls `read` until `pick` finds something, returning it. */
export async function eventually<T, R>(read: () => Promise<T>, pick: (v: T) => R | undefined | null | false, message: string, timeout = 30_000): Promise<R> {
  let found: R | undefined | null | false;
  await expect.poll(async () => { found = pick(await read()); return !!found; }, { message, timeout }).toBe(true);
  return found as R;
}

// Fixtures ------------------------------------------------------------------------------------------------------

export const test = base.extend<{ weft: WeftApi; freshWorld: void }>({
  weft: async ({ request }, use) => { await use(new WeftApi(request)); },
  // Runs before every test (auto): rebuild the world from the seed and confirm the frozen clock is at seed time.
  freshWorld: [async ({ weft }, use) => {
    await weft.reset();
    const clock = await weft.clock();
    expect(clock.now, "clock is back at the seed time after reset").toBe(SEED.now);
    expect(clock.rate, "E2E runs with a frozen clock").toBe(0);
    await use();
  }, { auto: true }],
});
