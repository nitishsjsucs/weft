"use client";
import { Dialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@weft/ui";
import { TID } from "@weft/contracts";
import { ALL_NAV } from "../nav";
import { useGet } from "@/lib/api/hooks";
import { period } from "../format";

interface Entry { id: string; label: string; hint: string; href: string }

/** Cmd+K: navigation plus record search over people and payroll runs (P0 scope, SPEC 11.3). */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const workers = useGet("/v1/workers", { query: { limit: 100 }, enabled: open });
  const runs = useGet("/v1/payrolls", { query: { limit: 25 }, enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => { if (!open) { setQ(""); setSel(0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const nav: Entry[] = ALL_NAV.map((n) => ({ id: `nav-${n.slug}`, label: n.label, hint: "Go to", href: n.href }));
    const ppl: Entry[] = (workers.data?.data ?? []).map((w) => ({ id: w.id, label: w.displayName, hint: `${w.title}, ${w.workState ?? w.country}`, href: `/app/people/${w.id}` }));
    const pay: Entry[] = (runs.data?.data ?? []).map((r) => ({ id: r.id, label: `Payroll ${period(r.periodStart, r.periodEnd)}`, hint: r.status, href: `/app/payroll/${r.id}` }));
    const needle = q.trim().toLowerCase();
    const all = needle ? [...nav, ...pay, ...ppl] : nav;
    return all.filter((e) => !needle || e.label.toLowerCase().includes(needle) || e.id.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, workers.data, runs.data]);

  const go = (e: Entry | undefined) => { if (!e) return; onOpenChange(false); router.push(e.href); };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-xl bg-card shadow-[var(--shadow-modal)] outline-none">
          <Dialog.Title className="sr-only">Search and navigate</Dialog.Title>
          <Dialog.Description className="sr-only">Type to search pages, people and payroll runs</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3">
            <Search className="size-4 text-gray-10" strokeWidth={1.5} />
            <input
              autoFocus
              data-testid={TID.cmdkInput}
              value={q}
              onChange={(e) => { setQ(e.target.value); setSel(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, entries.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                if (e.key === "Enter") { e.preventDefault(); go(entries[sel]); }
              }}
              placeholder="Search pages, people and payroll runs"
              className="h-11 min-w-0 flex-1 bg-transparent text-2 outline-none placeholder:text-gray-9"
            />
          </div>
          <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {entries.length === 0 ? <li className="px-3 py-6 text-center text-2 text-gray-10">No matches</li> : null}
            {entries.map((e, i) => (
              <li key={e.id} role="option" aria-selected={i === sel}>
                <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(e)} className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-2", i === sel && "bg-gray-3")}>
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  <span className="shrink-0 text-1 text-gray-10">{e.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
