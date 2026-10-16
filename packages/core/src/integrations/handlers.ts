// Wave 3 event handlers for integrations (docs/wave3.md): integration events re-read the vendor record and apply it through system commands.
// Owners: w3-integrations-hr fills hrHandlers, w3-integrations-screening-esign fills screeningEsignHandlers (separate files).
import type { EventHandler } from "@weft/contracts";
import { hrHandlers } from "./hr-handlers";
import { screeningEsignHandlers } from "./screening-handlers";

export const integrationsHandlers: EventHandler[] = [...hrHandlers, ...screeningEsignHandlers];
