"use client";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, tid, type Paycheck } from "@weft/contracts";
import { hours, initials } from "../format";
import { FlagChip } from "./flag-chip";

const features = tableFeatures({});
const h = createColumnHelper<typeof features, Paycheck>();
/**
 * Which card width a column needs before it shows. Gate report item 4: with the agent panel docked at 1440 px the card
 * is about 790 px wide, so the two columns the drawer repeats least often (reimbursements, company benefits) step
 * aside below a 960 px card. On a tablet-width card Hours and both tax columns go as well, and on a phone (a card under
 * 480 px) Gross pay too, so Employee and Net pay always stay in view. Every hidden figure is in the paycheck drawer one
 * click away. Narrower than any of that, the table scrolls inside its card.
 */
const SHOW_FROM = {
  wide: "hidden @min-[960px]:table-cell",
  tablet: "hidden @min-[720px]:table-cell",
  phone: "hidden @min-[480px]:table-cell",
} as const;
type ShowFrom = keyof typeof SHOW_FROM;

const money = (label: string, get: (p: Paycheck) => string, showFrom?: ShowFrom) => h.display({ id: label, header: label, cell: (c) => get(c.row.original), meta: { numeric: true, showFrom } });
const columns = h.columns([
  h.accessor("workerName", { header: "Employee", cell: (c) => c.getValue() }),
  h.display({ id: "Hours", header: "Hours", cell: (c) => hours(c.row.original.hoursX100), meta: { numeric: true, showFrom: "tablet" } }),
  money("Gross pay", (p) => p.gross.display, "phone"),
  money("Reimbursements", (p) => p.reimbursements.display, "wide"),
  money("Company taxes", (p) => p.companyTaxes.display, "tablet"),
  money("Employee taxes", (p) => p.employeeTaxes.display, "tablet"),
  money("Company benefits", (p) => p.companyBenefits.display, "wide"),
  money("Net pay", (p) => p.net.display),
]);

type ColMeta = { numeric?: boolean; showFrom?: ShowFrom } | undefined;
const showFrom = (meta: ColMeta) => (meta?.showFrom ? SHOW_FROM[meta.showFrom] : undefined);

const GROUPS = [
  { key: "needs_review", label: "Needs Review", testid: TID.payrollGroupNeedsReview, wash: "bg-amber-9/20", dot: "bg-amber-9" },
  { key: "ready", label: "Ready for Approval", testid: TID.payrollGroupReady, wash: "bg-green-9/20", dot: "bg-green-9" },
] as const;

/** Paycheck table (TanStack Table v9 useTable) with Needs Review and Ready for Approval bands. */
export function PaycheckTable({ data, onOpen }: { data: Paycheck[]; onOpen: (p: Paycheck) => void }) {
  const table = useTable({ features, columns, data });
  const rows = table.getRowModel().rows;
  const headers = table.getHeaderGroups();
  const ncol = columns.length;
  return (
    <div data-testid="paycheck-table-card" className="@container min-w-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-card shadow-xs">
      <Table>
        <THead>
          {headers.map((g) => (
            <TR key={g.id}>
              {g.headers.map((hd) => (
                <TH key={hd.id} numeric={(hd.column.columnDef.meta as ColMeta)?.numeric} className={cn(hd.column.id === "workerName" && "sticky left-0 z-10 bg-card", showFrom(hd.column.columnDef.meta as ColMeta))}>
                  {hd.isPlaceholder ? null : <table.FlexRender header={hd} />}
                </TH>
              ))}
            </TR>
          ))}
        </THead>
        {GROUPS.map((g) => {
          const groupRows = rows.filter((r) => r.original.reviewGroup === g.key);
          return (
            <TBody key={g.key} data-testid={g.testid} data-tour={g.key === "needs_review" ? "payroll-needs-review" : undefined} data-count={groupRows.length}>
              <tr className={cn("border-b border-[var(--app-border)]", g.wash)}>
                <td colSpan={ncol} className="px-3 py-1.5 text-1 font-medium">
                  <span className="sticky left-3 inline-flex items-center gap-2"><span className={cn("size-2 rounded-full", g.dot)} />{g.label} ({groupRows.length})</span>
                </td>
              </tr>
              {groupRows.map((r) => {
                const pc = r.original;
                return (
                  <TR
                    key={r.id}
                    data-testid={tid.payrollRow(pc.workerId)}
                    data-status={pc.status}
                    tabIndex={0}
                    onClick={() => onOpen(pc)}
                    onKeyDown={(e) => { if (e.key === "Enter") onOpen(pc); }}
                    className={cn("group cursor-pointer hover:bg-gray-2 focus-visible:bg-gray-2 focus-visible:outline-none", pc.status === "excluded" && "opacity-60")}
                  >
                    {r.getAllCells().map((cell) => {
                      const meta = cell.column.columnDef.meta as ColMeta;
                      const numeric = meta?.numeric;
                      if (cell.column.id === "workerName") {
                        return (
                          <TD key={cell.id} className="sticky left-0 z-10 bg-card py-2 group-hover:bg-gray-2">
                            <div className="flex items-start gap-2.5">
                              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-gray-4 text-0 font-medium text-gray-11">{initials(pc.workerName)}</span>
                              <div className="min-w-0">
                                <div className="font-medium break-words">{pc.workerName}</div>
                                {pc.flags.length ? <div className="mt-1 flex flex-wrap gap-1">{pc.flags.map((f) => <FlagChip key={f.rule} pc={pc} flag={f} />)}</div> : null}
                                {pc.status === "excluded" ? <div className="mt-0.5 text-1 text-gray-10">Excluded from this run</div> : null}
                              </div>
                            </div>
                          </TD>
                        );
                      }
                      return <TD key={cell.id} numeric={numeric} className={cn("whitespace-nowrap", showFrom(meta))}><table.FlexRender cell={cell} /></TD>;
                    })}
                  </TR>
                );
              })}
            </TBody>
          );
        })}
      </Table>
    </div>
  );
}
