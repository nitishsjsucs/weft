"use client";
// The in-app Platform page (docs/cloudflare/design.md 10): today's dollars against the caps, Workers AI neurons,
// restores left, leases, dead letters, the last Lobby sweep, the degradation level and each daily share. Aggregates
// only; no visitor's content ever reaches it. Hosted build only.
import { Activity, CircleDollarSign, Cpu, Gauge, Layers, RotateCcw, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import { HOSTED_PATHS } from "../../../../../packages/contracts/src/ext/cf-hosted";
import type { PlatformReadout } from "../../../../../packages/contracts/src/ext/cf-extras";
import { PageBody, PageHeader } from "../app/page";
import { levelText, usd } from "./copy";
import { useHostedGet } from "./use-hosted";

/** "1,234 of 60,000 (2%)". Exported for tests. */
export function shareLine(used: number, share: number): string {
  const f = new Intl.NumberFormat("en-US");
  const pct = share > 0 ? Math.round((used / share) * 100) : 0;
  return `${f.format(used)} of ${f.format(share)} (${pct}%)`;
}

/**
 * Human names for the readout's share keys: the Lobby's (apps/cf/src/core/lobby/policy.ts SHARES) and the extras'
 * daily counters (packages/cf-extras/src/platform.ts); an unknown key reads as itself.
 */
export const SHARE_LABEL: Record<string, string> = {
  doRowsWritten: "Durable Object rows written", doRowsRead: "Durable Object rows read", doRequests: "Durable Object requests",
  workersRequests: "Workers requests", "help.queries": "Help searches", "pdf.browser_seconds": "PDF rendering (browser seconds)",
};

function Tile({ icon, label, value, note, testid }: { icon: ReactNode; label: string; value: ReactNode; note?: ReactNode; testid: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4" data-testid={testid}>
      <div className="flex items-center gap-2 text-1 text-gray-10"><span className="[&_svg]:size-3.5">{icon}</span>{label}</div>
      <div className="text-6 font-semibold tabular text-gray-12">{value}</div>
      {note ? <div className="text-1 text-gray-10">{note}</div> : null}
    </Card>
  );
}

function Bar({ used, share }: { used: number; share: number }) {
  const pct = share > 0 ? Math.min(100, (used / share) * 100) : 0;
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-3"><div className={pct >= 90 ? "h-full bg-red-9" : pct >= 70 ? "h-full bg-amber-9" : "h-full bg-gray-11"} style={{ width: `${pct}%` }} /></div>;
}

export function PlatformView() {
  const q = useHostedGet<PlatformReadout>(HOSTED_PATHS.platform, 60_000);
  const r = q.data;
  return (
    <PageBody>
      <PageHeader title="Platform" subtitle="How hosted Weft runs on Cloudflare's free plan today: spend against the caps, the daily shares Weft keeps for itself, and the shared limits behind them." meta={r ? <Badge tone={r.level === 0 ? "green" : r.level >= 3 ? "red" : "amber"} size="md" data-testid="platform-level">Level {r.level}</Badge> : null} />
      {q.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{q.error}</div> : null}
      {!r ? (q.error ? null : <p className="text-2 text-gray-10">Loading...</p>) : (
        <div className="flex flex-col gap-6" data-testid="platform-readout" data-day={r.day}>
          <p className="text-2 text-gray-11">{levelText(r.level)} Counters reset at 00:00 UTC ({r.day}).</p>
          <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2 laptop:grid-cols-3">
            <Tile testid="platform-dollars" icon={<CircleDollarSign />} label="Model spend today" value={`${usd(r.dollars.spentUsd)} of ${usd(r.dollars.dayCapUsd)}`} note={`Each run is capped at ${usd(r.dollars.runCapUsd)}.`} />
            <Tile testid="platform-neurons" icon={<Cpu />} label="Workers AI neurons today" value={shareLine(r.neurons.used, r.neurons.cap)} />
            <Tile testid="platform-restores" icon={<RotateCcw />} label="Full restores left today" value={String(r.restoresLeft)} />
            <Tile testid="platform-leases" icon={<Users />} label="Workspaces in use" value={`${r.leases.active} of ${r.leases.pool}`} note={r.leases.waitlist ? `${r.leases.waitlist} waiting` : "No one waiting"} />
            <Tile testid="platform-dead-letters" icon={<Layers />} label="Dead-letter jobs" value={String(r.deadLetters)} />
            <Tile testid="platform-sweep" icon={<Activity />} label="Last Lobby sweep" value={r.lastSweepAt ? new Date(r.lastSweepAt).toISOString().slice(11, 16) + " UTC" : "Not yet"} />
          </div>
          <section>
            <CardHeading icon={<Gauge />}>Daily shares</CardHeading>
            <Card className="overflow-hidden">
              <Table data-testid="platform-shares">
                <THead><TR><TH>Limit</TH><TH className="text-right">Used of Weft's share</TH><TH className="w-[30%]"><span className="sr-only">Use</span></TH></TR></THead>
                <TBody>
                  {Object.entries(r.shares).map(([k, v]) => (
                    <TR key={k} data-share={k}><TD>{SHARE_LABEL[k] ?? k}</TD><TD className="text-right tabular">{shareLine(v.used, v.share)}</TD><TD><Bar used={v.used} share={v.share} /></TD></TR>
                  ))}
                  {Object.keys(r.shares).length === 0 ? <TR><TD colSpan={3} className="text-gray-10">No shares counted yet today.</TD></TR> : null}
                </TBody>
              </Table>
            </Card>
          </section>
        </div>
      )}
    </PageBody>
  );
}
