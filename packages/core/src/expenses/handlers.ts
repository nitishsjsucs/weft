// Wave 3 event handlers (docs/wave3.md). Owner: w3-expenses. Deterministic, run by the scheduler as svc_events: payroll.processed marks scheduled reimbursements paid.
import type { EventHandler } from "@weft/contracts";

export const expensesHandlers: EventHandler[] = [];
