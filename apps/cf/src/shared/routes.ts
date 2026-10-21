// Route classes the hosted gates use (design 6.2 and 6.3), on the API path after the /api prefix is stripped.
//
// Every route that can start a model call is a POST, so the human grant on every mutation already puts Turnstile in
// front of each of them. These are the direct agent admissions: the kill switch answers them 503 AGENT_PAUSED at the
// edge, and the slot applies RL_RUN to them per visitor. Runs a mutation starts in the background (a delivered
// notice, an accepted offer) use the scripted provider while the agent is paused, with the reason in the banner.
export const MODEL_ADMISSION_ROUTES: readonly RegExp[] = [
  /^\/v1\/agent\/runs$/,
  /^\/v1\/portal\/agent\/runs$/,
  /^\/v1\/routines\/draft$/,
  /^\/v1\/routines\/[^/]+\/trigger$/,
  /^\/v1\/sim\/chat\/inbound$/,
  /^\/v1\/sim\/email\/inbound$/,
];

export function isModelAdmission(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && MODEL_ADMISSION_ROUTES.some((r) => r.test(path));
}

/** Multipart bodies carry uploads (receipts, I-9 images, notices, certificates): capped and counted per visitor. */
export function isUpload(method: string, contentType: string | null): boolean {
  return method.toUpperCase() !== "GET" && (contentType ?? "").toLowerCase().startsWith("multipart/form-data");
}

/** The hosted reset: the front intercepts it and resets through the Lobby. */
export const SIM_RESET_PATH = "/v1/sim/reset";
export const HEALTH_PATH = "/v1/health";

/** Paths CompanyDO serves itself (the front rewrites the public paths onto them). */
export const DO_PATHS = { live: "/_live", mcp: "/mcp", model: "/_hosted/model", mcpKey: "/_hosted/mcp-key", pdf: "/_hosted/pdf" } as const;

/** Lease-end marker on a 409 LEASE_ENDED from a slot, so the front clears the cookie without parsing the body. */
export const LEASE_HEADER = "x-weft-lease";
