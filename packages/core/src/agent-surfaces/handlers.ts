// Wave 4 event handlers (docs/wave4.md). Owner: w4-parity-agent. Planned: chat.agent_mentioned, email.expense_received, routine.wait_resumed.
// handlers/index.ts concatenates this array; handlers run as svc_ principals and read payload ids only.
import type { EventHandler } from "@weft/contracts";

export const agentSurfacesHandlers: EventHandler[] = [];
