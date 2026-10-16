// Vendor polling on the scheduler tick (wave 3, docs/wave3.md). Owner: w3-integrations-hr. A local Weft cannot receive
// webhooks, so polling is the baseline: Greenhouse and Workday every 15 minutes of sim time through integrations.sync_now
// (svc_scheduler), then the screening and e-signature poll owned by w3-integrations-screening-esign. Scaffold: no-op.
import type { ExecutorBundle, SimClock } from "@weft/contracts";
import type { Db } from "@weft/db";
import { pollScreeningEsign } from "./poll-screening";

export interface PollDeps { db: Db; clock: SimClock; executor: ExecutorBundle; now: string }

export async function pollIntegrations(d: PollDeps): Promise<void> {
  await pollScreeningEsign(d);
}
