// GP14. Time off with a coverage conflict (docs/wave3.md 5). Owner of the spec: w3-timeoff.
// On Time Off, Ruth's pending vacation shows the coverage and holiday checks and is routed to Imani; Ben's sick day is
// blocked by the waiting period; the Hardware calendar outlines Nov 23 to 25 (3 of 9 out). Imani may decide only for
// her direct reports (checked by the API); the People admin approves Ruth's request on the Requests tab, the hold
// becomes use rows and the calendar marks the days approved. The TX vacation day is a pto line on the open draft with
// gross unchanged. ("Viewing as" Imani joins the persona menu with w3-topbar-shell; until then her call goes through
// the API here.)
import { W3_TIMEOFF_TID as T } from "../packages/contracts/src/index";
import { eventually, expect, openApp, SEED, test, WeftApi } from "./fixtures";

type Req = { id: string; status: string; approverPrincipalId: string | null; checks: { rule: string }[] };

test("GP14: coverage conflict routed to the manager, approved on the Requests tab, pto line on the draft", async ({ page, weft, request }) => {
  await test.step("Requests: Ruth's vacation carries its checks and routing; Ben's sick day is blocked", async () => {
    await openApp(page, "/app/time-off");
    await page.getByTestId(T.tab("requests")).click();
    const ruth = page.getByTestId(T.requestRow("tor_0003"));
    await expect(ruth).toHaveAttribute("data-status", "pending");
    await expect(ruth.getByTestId(T.check("COVERAGE_CONFLICT"))).toBeVisible();
    await expect(ruth.getByTestId(T.check("INCLUDES_HOLIDAY"))).toBeVisible();
    await expect(ruth).toContainText("3 of 9 out (33.3%)");
    await expect(ruth).toContainText("Routed to Imani Ferreira (demo)");
    await expect(page.getByTestId(T.requestRow("tor_0005")).getByTestId(T.check("WAITING_PERIOD"))).toBeVisible();
    const api = await weft.get<Req>("/v1/time-off/requests/tor_0003");
    expect(api).toMatchObject({ status: "pending", approverPrincipalId: "usr_imani" });
  });

  await test.step("Calendar: Hardware in November outlines Nov 23 to 25 and shades the holidays", async () => {
    await page.getByTestId(T.tab("calendar")).click();
    await expect(page.getByTestId(T.calendar)).toBeVisible();
    for (const d of ["2026-11-23", "2026-11-24", "2026-11-25"]) await expect(page.getByTestId(T.calendarDay(d))).toHaveAttribute("data-over", "true");
    await expect(page.getByTestId(T.calendarDay("2026-11-26"))).toHaveText("hol");
  });

  await test.step("Imani decides only for her direct reports", async () => {
    const imani = new WeftApi(request, "usr_imani");
    const refused = await imani.post<{ code?: string }>("/v1/time-off/requests/tor_0004/decide", { decision: "approve", note: "" }).catch((e: Error) => ({ code: e.message }));
    expect(JSON.stringify(refused)).toContain("DOMAIN_NOT_DIRECT_REPORT");
  });

  await test.step("the People admin approves Ruth's request; the hold becomes use rows and the calendar marks it approved", async () => {
    await page.getByTestId(T.tab("requests")).click();
    const ruth = page.getByTestId(T.requestRow("tor_0003"));
    await ruth.getByTestId(T.decide("approve")).click();
    await expect(page.getByRole("status")).toContainText("Approved Ruth Okoro (demo)'s vacation");
    await eventually(() => weft.get<Req>("/v1/time-off/requests/tor_0003"), (r) => r.status === "approved", "Ruth's request is approved");
    const ledger = await weft.get<{ kind: string; minutes: number; source_ref: string | null }[]>("/v1/time-off/ledger", { workerId: "wrk_0010", policyId: "top_vac_us" });
    expect(ledger.filter((l) => l.kind === "use" && l.source_ref === "tor_0003").reduce((s, l) => s + l.minutes, 0)).toBe(-1_440);
    await page.getByTestId(T.tab("calendar")).click();
    const cal = await weft.get<{ days: { date: string; out: { requestId: string; status: string }[] }[] }>("/v1/time-off/calendar", { departmentId: "dpt_hardware", from: "2026-11-23", to: "2026-11-25" });
    expect(cal.days.every((d) => d.out.some((o) => o.requestId === "tor_0003" && o.status === "approved"))).toBe(true);
  });

  await test.step("the TX vacation day is a pto line on the open draft with gross unchanged", async () => {
    const page1 = await weft.get<{ data: { workerId: string; gross: { amount: number }; earnings: { type: string; amountCents: number }[] }[] }>(`/v1/payrolls/${SEED.draftRun}/paychecks`, { limit: 100 });
    const lucy = page1.data.find((p) => p.workerId === "wrk_0038")!;
    expect(lucy.earnings.map((e) => [e.type, e.amountCents])).toEqual([["salary", 431_154], ["pto", 43_846]]);
    expect(lucy.gross.amount).toBe(475_000);
  });
});
