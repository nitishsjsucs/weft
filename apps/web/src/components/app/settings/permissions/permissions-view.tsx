"use client";
// Permissions (wave 4, w4-parity-admin): the View, Edit and Approve matrix per domain for each person, what the agent
// may do when it acts for them (its grant intersected with theirs, approve capped at edit), the agent's own row, and
// per-action overrides that narrow the agent below those grants. Changing an override files a proposal
// (settings.set_agent_action_override); the matrix changes only once a person approves it in the Inbox.
import Link from "next/link";
import { useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CardHeading, TBody, TD, TH, THead, TR, Table } from "@weft/ui/components";
import type { PermissionMatrixRow, ToolOutcome } from "@weft/contracts";
import { client, errorText, useGet, useMutation } from "@/lib/api/hooks";
import { PageHeader } from "../../page";
import { W4_ADMIN_TID as T } from "../../reports/testids";

const DOMAINS = ["people", "payroll", "tax", "benefits", "it", "comms", "company"] as const;
const DOMAIN_LABEL: Record<string, string> = { people: "People", payroll: "Payroll", tax: "Taxes", benefits: "Benefits", it: "IT", comms: "Comms", company: "Company" };
const LEVEL_TONE = { none: "outline", view: "gray", edit: "blue", approve: "green" } as const;
const LEVEL_LABEL = { none: "None", view: "View", edit: "Edit", approve: "Approve" } as const;
const MODE_LABEL = { deny: "Denied", propose_only: "Always a proposal" } as const;
const field = "h-8 rounded-lg bg-card px-2.5 text-[13px] shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";

type Level = keyof typeof LEVEL_TONE;
const asLevel = (v: string | undefined): Level => (v === "view" || v === "edit" || v === "approve" ? v : "none");

function LevelCell({ id, level, agent }: { id: string; level: Level; agent: Level }) {
  return (
    <TD data-testid={id} data-level={level} data-agent-level={agent} className="whitespace-nowrap px-1.5">
      <span className="flex flex-col items-start gap-0.5">
        <Badge tone={LEVEL_TONE[level]} size="xs">{LEVEL_LABEL[level]}</Badge>
        <span className="flex items-center gap-1 text-0 text-gray-10" title="What the agent may do when it acts for this person"><Bot className="size-3" aria-label="Agent" />{LEVEL_LABEL[agent]}</span>
      </span>
    </TD>
  );
}

function OverrideForm({ rows }: { rows: PermissionMatrixRow[] }) {
  const [principalId, setPrincipalId] = useState(rows.at(-1)?.principalId ?? "");
  const [command, setCommand] = useState("comms.send_message");
  const [mode, setMode] = useState<"deny" | "propose_only" | "clear">("propose_only");
  const [result, setResult] = useState<ToolOutcome | null>(null);
  const file = useMutation(async () => {
    const o = (await client.post("/v1/permissions/agent-actions", { body: { principalId, command: command.trim(), mode } })) as ToolOutcome;
    setResult(o);
    return o;
  });
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="text-[13px] text-gray-11">Narrow the agent for one command, below the domain grants: deny hides the command from the agent, and always a proposal makes every call wait for approval. Each change is itself a proposal.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-1 text-gray-11">
          For
          <select data-testid={T.overridePrincipal} className={`${field} max-w-full`} value={principalId} onChange={(e) => setPrincipalId(e.target.value)}>
            {rows.map((r) => <option key={r.principalId} value={r.principalId}>{r.role === "agent" ? "Every agent run" : `Agent acting for ${r.name}`}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-1 text-gray-11">
          Command
          <input data-testid={T.overrideCommand} className={`${field} w-56 max-w-full font-mono`} value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-1 text-gray-11">
          Override
          <select data-testid={T.overrideMode} className={field} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="propose_only">Always a proposal</option><option value="deny">Deny</option><option value="clear">Clear</option>
          </select>
        </label>
        <Button size="sm" variant="primary" data-testid={T.overrideSubmit} disabled={file.pending || !principalId || !command.trim()} onClick={() => void file.run()}>File for approval</Button>
      </div>
      {result && result.ok && result.status === "pending_approval" ? (
        <p data-testid={T.overrideResult} data-status="pending_approval" className="text-[13px] text-gray-11">Waiting for approval in the <Link className="underline" href="/app/inbox">Inbox</Link>. The matrix changes once it is approved.</p>
      ) : null}
      {result && !result.ok ? <p data-testid={T.overrideResult} data-status="refused" className="text-[13px] text-red-11">{result.refusal.message}</p> : null}
      {file.error ? <p data-testid={T.overrideResult} data-status="error" className="text-[13px] text-red-11">{errorText(file.error)}</p> : null}
    </Card>
  );
}

/** Roles as people say them ("hr_manager" is "HR manager"). */
const ROLE_WORDS: Record<string, string> = { admin: "Admin", payroll_admin: "Payroll admin", hr_manager: "HR manager", manager: "Manager", employee: "Employee" };

export function PermissionsView() {
  const q = useGet("/v1/permissions/matrix");
  const rows = (q.data ?? []) as unknown as PermissionMatrixRow[];
  const overrides = rows.flatMap((r) => r.overrides.map((o) => ({ ...o, who: r.role === "agent" ? "Every agent run" : r.name })));
  return (
    <div data-testid={T.permissionsPage} className="mx-auto w-full max-w-[1100px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Permissions" crumb="Permissions" subtitle="View, Edit and Approve per domain for each person. Under each level is what the agent may do when it acts for that person: never more than they can, and never Approve." />
      {q.error ? <Card className="mb-4 p-4 text-[13px] text-red-11">{errorText(q.error)}</Card> : null}
      <CardHeading icon={<ShieldCheck />}>Access by domain</CardHeading>
      {/* Eight domain columns fit a 620 px content column (the agent panel docked at 1280): tight cells, a person
          column that wraps, and each person's overrides under their role instead of a column of their own. The person
          column stays pinned if a narrower screen scrolls the table sideways (the Table fades the edge it runs past). */}
      <Card className="mb-6 p-1">
          <Table data-testid={T.matrix} data-tour="permissions-matrix" data-count={rows.length} data-rows={rows.length} className="min-w-full">
            <THead>
              <TR>
                <TH scope="col" className="sticky left-0 z-[1] bg-card">Person</TH>
                {DOMAINS.map((d) => <TH key={d} scope="col" className="px-1.5">{DOMAIN_LABEL[d]}</TH>)}
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.principalId} data-testid={T.matrixRow(r.principalId)} data-entity={r.principalId} data-entity-kind="principal" data-tour={r.role === "agent" ? "permissions-agent-row" : undefined}>
                  <TH scope="row" className="sticky left-0 z-[1] h-auto w-[8.5rem] min-w-[8.5rem] bg-card py-2 text-left font-normal whitespace-normal">
                    <span className="block leading-snug font-medium text-gray-12">{r.name}</span>
                    <span className="block text-1 text-gray-10">{r.role === "agent" ? "The agent (every run)" : ROLE_WORDS[r.role] ?? r.role.replace(/_/g, " ")}</span>
                    <span data-testid={T.overrideList(r.principalId)} data-count={r.overrides.length} className={r.overrides.length ? "block text-1 text-amber-11" : "sr-only"}>
                      {r.overrides.length ? `Override: ${r.overrides.map((o) => o.command).join(", ")}` : "No overrides"}
                    </span>
                  </TH>
                  {DOMAINS.map((d) => <LevelCell key={d} id={T.matrixCell(r.principalId, d)} level={asLevel(r.domains[d])} agent={asLevel(r.agentDomains[d])} />)}
                </TR>
              ))}
            </TBody>
          </Table>
      </Card>
      <CardHeading icon={<Bot />}>Per-action overrides</CardHeading>
      {overrides.length ? (
        <Card className="mb-3 p-1">
          <ul className="m-0 list-none p-0">
            {overrides.map((o) => (
              <li key={o.id} data-entity={o.id} data-entity-kind="permission_override" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-a3 px-3 py-2 text-[13px] last:border-0">
                <span className="font-mono">{o.command}</span>
                <Badge tone={o.mode === "deny" ? "red" : "amber"} size="xs">{MODE_LABEL[o.mode]}</Badge>
                <span className="text-gray-11">{o.who}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {rows.length ? <OverrideForm rows={rows} /> : null}
    </div>
  );
}
