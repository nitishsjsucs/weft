// Wave 4 event handlers (docs/wave4.md). Owner: w4-parity-compliance. Planned: filing.filed, notice.uploaded and training events.
// handlers/index.ts concatenates this array; handlers run as svc_ principals and read payload ids only.
import type { EventHandler } from "@weft/contracts";

export const complianceHandlers: EventHandler[] = [];
