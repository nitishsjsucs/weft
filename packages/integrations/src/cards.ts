// Integrations screen copy (docs/wave3.md), in Weft's own words. Vendor names are used only to say what Weft connects to;
// no logos, no vendor marketing copy. Owner: the architect; tracks change copy through a contract request.
import type { IntegrationVendor } from "@weft/contracts";

export interface VendorCopy { title: string; body: string; freePath: string; connect: string }

export const VENDOR_COPY: Record<IntegrationVendor, VendorCopy> = {
  greenhouse: {
    title: "Greenhouse",
    body: "Bring hired candidates into Weft as draft offers, then send them through the Weft portal, signing and onboarding.",
    freePath: "No free sandbox for individuals. The simulator follows the Harvest v3 shapes, and open roles can be read from a public job board with no key.",
    connect: "Connect Greenhouse",
  },
  workday: {
    title: "Workday",
    body: "Keep people, pay and approved time off in sync when Workday is the HR system of record. Weft runs payroll downstream.",
    freePath: "The Workday developer program offers a personal development tenant in beta; which APIs it includes is not stated. Until one is connected, the simulator runs.",
    connect: "Connect Workday",
  },
  checkr: {
    title: "Checkr",
    body: "Order a background check after an offer is accepted. The screening company collects consent; results feed the onboarding checklist.",
    freePath: "Staging access needs a credentialed business account. Weft ships a simulator that follows the published API and never calls production.",
    connect: "Connect Checkr",
  },
  hireright: {
    title: "HireRight",
    body: "Order background checks through HireRight for companies that already contract with it.",
    freePath: "HireRight publishes no public API or sandbox. Weft offers a simulator only, labeled as such, until a customer contract supplies an API.",
    connect: "Not available",
  },
  docusign: {
    title: "DocuSign",
    body: "Send the offer letter and the confidentiality agreement as one envelope and let the new hire sign inside the Weft portal.",
    freePath: "Free developer account with the full eSignature API in a demo environment (signatures there are not legally binding). Built-in click to sign stays the default.",
    connect: "Connect DocuSign",
  },
};
