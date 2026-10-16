// The top bar's labels and rules (research/wave3/topbar-design.md 5.3 to 5.8; owner w3-topbar-shell): model state and
// its dot, the three width tiers, the clock popover rows, persona grouping and the breadcrumb titles.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { shortcutLabel } from "@weft/ui/components";
import {
  clockAria, firstName, fmtLongClock, fmtUsd, groupPersonas, initials, MODE_LABEL, modelAria, modelLabel, modelState,
  nextRoutineSlot, rateLabel, roleLabel, tierFor,
} from "../src/components/app/shell/env";
import { crumbs } from "../src/components/app/nav";
import { PRINCIPALS } from "../src/lib/api/mocks/world";
import { StatusBadge, StatusText, statusLabel, statusTone } from "../src/components/app/status-badge";
import { PageBody } from "../src/components/app/page";
import { ExpenseStatus, NoticeStatus, OfferStatus, PaycheckStatus, PayrollRunStatus, TaxAccountStatus, TimeOffRequestStatus, WorkerStatus } from "@weft/contracts";

const plain = (s: string) => s.replace(/[  ]/g, " ");
const OPENAI = { id: "openai", model: "gpt-5.6-luna", label: "OpenAI gpt-5.6-luna", live: true };
const LOCAL = { id: "openai_compat", model: "mlx-community/Qwen3.6-27B", label: "Local Qwen3.6-27B", live: true };
const SCRIPTED = { id: "scripted", model: "scripted", label: "Scripted, no model", live: false };
const SEED_NOW = "2026-10-26T15:30:00.000Z"; // Monday 8:30 AM PT

describe("model segment", () => {
  it("reads hosted, local, scripted, offline and loading from the health check", () => {
    expect(modelState(OPENAI, false)).toBe("live");
    expect(modelState(LOCAL, false)).toBe("local");
    expect(modelState(SCRIPTED, false)).toBe("scripted");
    expect(modelState(undefined, true)).toBe("offline");
    expect(modelState(undefined, false)).toBe("loading");
    expect(MODE_LABEL.live).toBe("Live, metered");
    expect(MODE_LABEL.local).toBe("Local, unmetered");
  });

  it("shows the full label in Full, the model id in Compact, and never colors a scripted provider", () => {
    expect(modelLabel(OPENAI, "live", "full")).toBe("OpenAI gpt-5.6-luna");
    expect(modelLabel(OPENAI, "live", "compact")).toBe("gpt-5.6-luna");
    expect(modelLabel(SCRIPTED, "scripted", "full")).toBe("Scripted");
    expect(modelLabel(SCRIPTED, "scripted", "compact")).toBe("Scripted");
    expect(modelLabel(undefined, "offline", "compact")).toBe("API offline");
  });

  it("puts the whole meaning in the accessible name, since narrow tiers drop the visible text", () => {
    expect(modelAria(OPENAI, "live")).toBe("Model: OpenAI gpt-5.6-luna, live and metered");
    expect(modelAria(SCRIPTED, "scripted")).toBe("Model: Scripted, no model, scripted, no model calls");
    expect(modelAria(undefined, "offline")).toBe("Model: API offline");
  });

  it("formats spend in dollars, with four places under a cent", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.0031)).toBe("$0.0031");
    expect(fmtUsd(0.31)).toBe("$0.31");
  });
});

describe("clock segment", () => {
  it("names the simulated time in full for the popover and the accessible name", () => {
    expect(plain(fmtLongClock(SEED_NOW))).toBe("Monday, October 26, 8:30 AM PT");
    expect(plain(clockAria(SEED_NOW))).toBe("Simulated time: Monday, October 26, 8:30 AM Pacific");
  });

  it("reads the rate as paused, real time or a multiplier", () => {
    expect(rateLabel(0)).toBe("Paused");
    expect(rateLabel(1)).toBe("Real time");
    expect(rateLabel(60)).toBe("60x");
  });

  it("finds the next routine slot the same way the API's toNext cron does (09:00 PT on a weekday)", () => {
    expect(nextRoutineSlot(SEED_NOW)).toBe("2026-10-26T16:00:00.000Z");
    expect(nextRoutineSlot("2026-10-26T16:00:00.000Z")).toBe("2026-10-27T16:00:00.000Z");
    // Friday 9:00 AM PT moves to Monday.
    expect(nextRoutineSlot("2026-10-30T16:00:00.000Z")).toBe("2026-11-02T17:00:00.000Z");
  });
});

describe("persona menu", () => {
  it("shows initials and first names without the demo marker", () => {
    expect(initials("Dana Whitfield (demo)")).toBe("DW");
    expect(initials("Rowan Ellery")).toBe("RE");
    expect(firstName("Theo Marsh (demo)")).toBe("Theo");
  });

  it("groups admins, managers and employees in that order and drops empty groups", () => {
    expect(groupPersonas(PRINCIPALS).map((g) => [g.group, g.people.map((p) => p.id)])).toEqual([["Admins", ["usr_dana", "usr_theo", "usr_sam"]]]);
    const withManager = [...PRINCIPALS, { id: "usr_imani", name: "Imani (demo)", title: "Engineering Manager", role: "manager" }, { id: "usr_e", name: "E (demo)", title: "Engineer", role: "employee" }];
    expect(groupPersonas(withManager).map((g) => g.group)).toEqual(["Admins", "Managers", "Employees"]);
    expect(roleLabel("payroll_admin")).toBe("payroll admin");
    expect(roleLabel("hr_manager")).toBe("HR manager");
  });

  it("labels the search shortcut for the platform", () => {
    expect(shortcutLabel("K", "macOS")).toBe("⌘K");
    expect(shortcutLabel("K", "MacIntel")).toBe("⌘K");
    expect(shortcutLabel("K", "Windows")).toBe("Ctrl K");
  });
});

describe("tiers and breadcrumbs", () => {
  it("collapses by the header's own width: Full from 760, Compact from 480", () => {
    expect(tierFor(856)).toBe("full");
    expect(tierFor(760)).toBe("full");
    expect(tierFor(696)).toBe("compact");
    expect(tierFor(390)).toBe("mini");
  });

  it("shows a detail page's title instead of its raw id, and marks the id while the title loads", () => {
    expect(crumbs("/app/people/wrk_0001", "Dana Whitfield (demo)")).toEqual([{ label: "People", href: "/app/people" }, { label: "Dana Whitfield (demo)" }]);
    expect(crumbs("/app/people/wrk_0001")).toEqual([{ label: "People", href: "/app/people" }, { label: "wrk_0001", id: true }]);
    expect(crumbs("/app/payroll/pay_2026_09_15", "Sep 1 to Sep 15")[1]).toEqual({ label: "Sep 1 to Sep 15" });
    expect(crumbs("/app/inbox")).toEqual([{ label: "Inbox", href: "/app/inbox" }]);
    expect(crumbs("/app/runs/run_0001")).toEqual([{ label: "Runs", href: "/app" }]);
  });
});

describe("one status map", () => {
  it("renders statuses in sentence case with one tone per meaning", () => {
    expect(statusLabel("processed")).toBe("Processed");
    expect(statusLabel("needs_review")).toBe("Needs review");
    expect(statusLabel("approved_taxable")).toBe("Approved, taxable");
    expect(statusTone("processed")).toBe("green");
    expect(statusTone("active")).toBe("green");
    expect(statusTone("pending")).toBe("amber");
    expect(statusTone("failed")).toBe("red");
    expect(statusTone("draft")).toBe("gray");
    expect(statusTone("pending", "offboarding_step")).toBe("gray");
    expect(statusTone("open", "reconciliation")).toBe("amber");
    expect(statusTone("something_new")).toBe("gray");
  });

  it("knows every status the contracts define, so nothing falls through to gray by accident", () => {
    const all = [PayrollRunStatus, WorkerStatus, OfferStatus, NoticeStatus, TaxAccountStatus, PaycheckStatus, ExpenseStatus, TimeOffRequestStatus].flatMap((e) => e.options as readonly string[]);
    const unknown = all.filter((s) => statusTone(s) === "gray" && !["draft", "inactive", "voided", "excluded", "not_registered", "cancelled"].includes(s));
    expect(unknown).toEqual([]);
  });

  it("the payroll list and People read the same: a badge, or plain text in dense tables", () => {
    const badge = renderToStaticMarkup(<StatusBadge status="processed" />);
    expect(badge).toContain(">Processed<");
    expect(badge).toContain("bg-green-3");
    expect(badge).toContain('data-status="processed"');
    const text = renderToStaticMarkup(<StatusText status="active" />);
    expect(text).toContain(">Active<");
    expect(text).toContain("text-green-11");
  });
});

describe("page widths", () => {
  it("uses the three width tokens and one padding", () => {
    expect(renderToStaticMarkup(<PageBody>x</PageBody>)).toContain("max-w-[var(--page-w-default)]");
    expect(renderToStaticMarkup(<PageBody width="wide">x</PageBody>)).toContain("max-w-[var(--page-w-wide)]");
    const narrow = renderToStaticMarkup(<PageBody width="narrow">x</PageBody>);
    expect(narrow).toContain("max-w-[var(--page-w-narrow)]");
    expect(narrow).toContain("px-4 py-6 tablet:px-8 tablet:py-8");
  });
});
