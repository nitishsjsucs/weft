// A visitor's own way in (design 6.2), track cf7-integrate, on the local stack only: the real Turnstile widget with
// Cloudflare's always-pass test sitekey (the hosted export's default), its dummy token verified by the front Worker
// against the local siteverify stub (Cloudflare's test-secret answers), the lease that switches the tab to the
// visitor's own slot, the 428 human-grant refresh on a mutation, and the waitlist once the pool is full. At most two
// leases: the operator lease the run already holds (global-setup) and this visitor's; the second visitor is refused
// with the waitlist. The deployed project never runs this file (a real challenge is never solved by automation).
import { bannerWorld, expect, test, trackMutations } from "./fixtures";
import { mutationHeadroom } from "./world";
import { LOCAL } from "./auth";
import type { StubCall } from "./siteverify-stub";

test.skip(({ baseURL }) => !(baseURL ?? "").startsWith(LOCAL.origin), "local only: visitors start leases through Turnstile");

const stubCalls = async (): Promise<StubCall[]> => ((await (await fetch(`http://localhost:${LOCAL.stubPort}/calls`)).json()) as { calls: StubCall[] }).calls;

/** Open my workspace: the widget runs, the token goes to /api/_session/lease; returns that answer. */
async function start(page: import("@playwright/test").Page): Promise<{ status: string; slot?: string; position?: number; poolSize?: number }> {
  await page.goto("/app/");
  expect(await bannerWorld(page)).toBe("showcase");
  const lease = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/_session/lease" && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByTestId("hosted-start-cta").click();
  await expect(page.getByTestId("hosted-start")).toBeVisible();
  const res = await lease;
  expect(res.status(), "the lease request passes Turnstile").toBe(200);
  return (await res.json()) as { status: string; slot?: string; position?: number; poolSize?: number };
}

test("Turnstile starts a visitor's own workspace, a mutation refreshes the human grant, and a full pool answers with the waitlist", async ({ browser, operator }) => {
  test.setTimeout(240_000);
  void operator;   // the run's operator lease holds one of the two pool slots
  const before = (await stubCalls()).length;

  // The lease, the grant refresh with its retried mutation, and the second visitor's lease: room under RL_MUTATE first.
  await mutationHeadroom(8);
  const a = await browser.newContext();
  trackMutations(a);
  const pa = await a.newPage();
  const ra = await start(pa);
  expect(ra.status).toBe("leased");
  expect(ra.slot).toMatch(/^slot-\d$/);
  expect(ra.slot).not.toBe(operator.lease.slot);
  expect(await bannerWorld(pa)).toBe("slot");
  await expect(pa.getByTestId("hosted-world")).toHaveAttribute("data-slot", ra.slot!);
  await expect(pa.getByTestId("hosted-start")).toHaveCount(0);
  const calls = (await stubCalls()).slice(before);
  expect(calls.at(-1), "siteverify saw the test secret, the dummy token, the visitor's address and one idempotency key").toMatchObject({ secretKind: "pass", dummyToken: true, remoteip: true, idempotencyKey: true, success: true });

  // The 428 path: without the grant cookie a mutation answers TURNSTILE_REQUIRED; the shell runs the widget, posts
  // the token to /api/_session/verify and retries once.
  await a.clearCookies({ name: "__Host-weft-h" });
  await pa.goto("/app/simulators/");
  const verify = pa.waitForResponse((r) => new URL(r.url()).pathname === "/api/_session/verify" && r.request().method() === "POST", { timeout: 60_000 });
  const advanced = pa.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/sim/clock/advance" && r.status() === 200, { timeout: 90_000 });
  await pa.getByTestId("sim-advance-1d").click();
  expect((await verify).status(), "the grant refresh passes Turnstile").toBe(200);
  await advanced;
  await expect(pa.getByTestId("sim-clock-now")).toContainText("Oct 27");
  expect((await a.cookies()).some((c) => c.name === "__Host-weft-h"), "a fresh grant cookie").toBe(true);

  // A second visitor while both slots are leased: the waitlist, with the pool size and a position.
  const b = await browser.newContext();
  trackMutations(b);
  const pb = await b.newPage();
  const rb = await start(pb);
  expect(rb).toMatchObject({ status: "waitlist", poolSize: 2, position: 1 });
  await expect(pb.getByTestId("hosted-start-blocked")).toHaveAttribute("data-status", "waitlist");
  await expect(pb.getByTestId("hosted-start-blocked")).toContainText("All 2 workspaces are in use.");
  expect(await bannerWorld(pb)).toBe("showcase");
  await a.close();
  await b.close();
});
