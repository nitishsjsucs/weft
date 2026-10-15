// An in-package fake AgentExecutor (the real one is T3's). It mirrors the contract: wire names, frozen sorted tool
// specs with a 16-tool cap, dedupe on (run, call id), proposals for gated commands and runState.
import type { AgentCall, AgentExecutor, RegistryView, RunHandle, ToolOutcome, ToolSpec } from "@weft/contracts";

export type FakeHandler = (args: Record<string, unknown>, ctx: { runId: string; callId: string }) => ToolOutcome | Promise<ToolOutcome>;
export interface FakeCommand { name: string; effect: "read" | "draft" | "write" | "external"; gated?: boolean; handler?: FakeHandler; description?: string }

export interface FakeProposal { id: string; runId: string; command: string; args: unknown; status: "pending" | "approved" | "denied" | "executed" }

export interface FakeExecutor extends AgentExecutor {
  calls: { runId: string; callId: string; command: string; args: unknown }[];
  proposals: FakeProposal[];
  settleProposal(proposalId: string, approve: boolean): FakeProposal;
  taint(runId: string, by: string): void;
}

export const wire = (name: string) => name.replace(".", "__");

export function createFakeExecutor(commands: FakeCommand[]): FakeExecutor {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const byWire = new Map(commands.map((c) => [wire(c.name), c]));
  const outcomes = new Map<string, ToolOutcome>();
  const taints = new Map<string, string>();
  let seq = 0;
  let prp = 0;
  const calls: FakeExecutor["calls"] = [];
  const proposals: FakeProposal[] = [];

  const spec = (c: FakeCommand): ToolSpec => ({
    name: wire(c.name),
    description: c.description ?? `Fake ${c.name}.`,
    parameters: { additionalProperties: false, properties: {}, required: [], type: "object" },
  });

  const registry: RegistryView = {
    get(n) {
      const c = byName.get(n) ?? byWire.get(n);
      return c ? { name: c.name as never, description: c.description ?? "", effect: c.effect, tiers: { main: "executable", task: "unavailable" }, mcp: "read" } : undefined;
    },
    toolSpecs({ allowlist }) {
      if (allowlist.length > 16) throw new Error(`tool-count cap: ${allowlist.length} tools > 16`);
      return allowlist.map((n) => {
        const c = byName.get(n) ?? { name: n, effect: "read" as const };
        return spec(c);
      }).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    wireName: wire,
  };

  return {
    registry,
    calls,
    proposals,
    async exec(run: RunHandle, call: AgentCall) {
      const key = `${run.runId}:${call.callId}`;
      const prior = outcomes.get(key);
      if (prior) return prior;
      const c = byName.get(call.command) ?? byWire.get(call.command);
      const tainted = taints.has(run.runId);
      calls.push({ runId: run.runId, callId: call.callId, command: c?.name ?? call.command, args: call.args });
      let out: ToolOutcome;
      if (!c) out = { ok: false, refusal: { code: "UNKNOWN_COMMAND", message: `No tool ${call.command}.`, hint: null, example: null }, tainted };
      else if (c.gated) {
        const id = `prp_${String(++prp).padStart(4, "0")}`;
        proposals.push({ id, runId: run.runId, command: c.name, args: call.args, status: "pending" });
        out = { ok: true, status: "pending_approval", proposalId: id, title: `Proposed ${c.name}`, expiresAt: "2026-10-30T00:00:00.000Z", tainted };
      } else if (c.handler) out = await c.handler((call.args ?? {}) as Record<string, unknown>, { runId: run.runId, callId: call.callId });
      else out = { ok: true, status: "done", resultId: `res_${String(++seq).padStart(4, "0")}`, data: { ok: true }, summary: `Ran ${c.name}`, actionSeq: c.effect === "read" ? null : seq, artifactRef: null, tainted, label: "synthetic" };
      outcomes.set(key, out);
      return out;
    },
    async readArtifact() {
      return { ok: false, refusal: { code: "UNKNOWN_REFERENCE", message: "no artifacts in the fake", hint: null, example: null }, tainted: false };
    },
    async runState(run) {
      return { tainted: taints.has(run.runId), taintedBy: taints.get(run.runId) ?? null, pendingProposalIds: proposals.filter((p) => p.runId === run.runId && p.status === "pending").map((p) => p.id) };
    },
    settleProposal(proposalId, approve) {
      const p = proposals.find((x) => x.id === proposalId);
      if (!p) throw new Error(`no proposal ${proposalId}`);
      p.status = approve ? "executed" : "denied";
      return p;
    },
    taint(runId, by) {
      taints.set(runId, by);
    },
  };
}
