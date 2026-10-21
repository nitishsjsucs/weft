// Real docusign adapter (docs/wave3.md). Owner: w3-integrations-screening-esign. Built against eSignature REST v2.1 (JWT grant, embedded signing, Connect HMAC) behind WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1.
// The only code in Weft that calls this vendor over HTTP. Credentials come from ./secrets readSecret, never logged.
// Shapes from research/wave3/integrations-screening-esign.md 4: an RS256 JWT assertion signed with node:crypto (iss the
// integration key, sub the user id, aud the OAuth host, scope "signature impersonation"), exchanged for a one-hour token
// renewed 15 minutes early; the base URI from /oauth/userinfo; one envelope per offer with both documents and one embedded
// signer (clientUserId); a fresh recipient view per click; Connect HMAC in base64 over the raw body; at most one status
// read per envelope every 15 minutes (DocuSign's hard limit; Weft's poller spaces them 20 minutes apart).
import { createHash, createSign } from "node:crypto";
import type { ConnectorStatus, ESignConnector, EnvelopeStatus, WebhookVerdict } from "@weft/contracts";
import { isTestEnv, LiveIntegrationInTest } from "../mode";
import { readSecret, type Env } from "../secrets";
import { constantTimeEqual, hmacSha256 } from "../webhook";
import { IntegrationRefused } from "./checkr";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

type Fetch = typeof fetch;
type Json = Record<string, unknown>;
export const DOCUSIGN_OAUTH = { demo: "account-d.docusign.com", production: "account.docusign.com" } as const;
export const DOCUSIGN_MIN_POLL_MS = 15 * 60_000;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** The JWT grant assertion (RS256). Exported for tests, which verify it with the matching public key. */
export function docusignAssertion(i: { integrationKey: string; userId: string; aud: string; privateKeyPem: string; nowSec: number }): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: i.integrationKey, sub: i.userId, aud: i.aud, iat: i.nowSec, exp: i.nowSec + 3600, scope: "signature impersonation" }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(i.privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

export function docusignDedupeKey(envelopeId: string, event: string, generatedDateTime: string): string {
  return createHash("sha256").update(`${envelopeId}${event}${generatedDateTime}`).digest("hex");
}
export function parseDocusignConnect(raw: Uint8Array): { dedupeKey: string; envelopeId: string; event: string }[] {
  try {
    const b = JSON.parse(Buffer.from(raw).toString("utf8")) as { event?: unknown; generatedDateTime?: unknown; data?: { envelopeId?: unknown } };
    if (typeof b.event !== "string" || typeof b.generatedDateTime !== "string" || typeof b.data?.envelopeId !== "string") return [];
    return [{ dedupeKey: docusignDedupeKey(b.data.envelopeId, b.event, b.generatedDateTime), envelopeId: b.data.envelopeId, event: b.event }];
  } catch { return []; }
}
/** Connect HMAC: one X-DocuSign-Signature-N header per key, base64 HMAC-SHA256 of the raw body; one match is enough. */
export function verifyDocusignConnect(raw: Uint8Array, headers: Record<string, string>, key: string): boolean {
  const want = hmacSha256(key, raw, "base64");
  return Object.entries(lower(headers)).some(([k, v]) => /^x-docusign-signature-\d+$/.test(k) && constantTimeEqual(want, v.trim()));
}

export interface DocusignClientOptions { env: Env; fetch?: Fetch; nowMs?: () => number }

export function createDocusignClient(o: DocusignClientOptions): ESignConnector {
  const env = o.env, f: Fetch = o.fetch ?? ((...a) => fetch(...a)), nowMs = o.nowMs ?? (() => Date.now());
  const oauthHost = env.DOCUSIGN_ENV === "production" ? DOCUSIGN_OAUTH.production : DOCUSIGN_OAUTH.demo;
  const guard = () => {
    if (env.WEFT_ESIGN !== "docusign" || env.WEFT_LIVE_DOCUSIGN !== "1") throw new IntegrationRefused("INTEGRATION_LIVE_DISABLED", "DocuSign needs WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1");
    if (!o.fetch && isTestEnv(env)) throw new LiveIntegrationInTest("docusign");
  };
  let token: { value: string; renewAt: number; baseUri: string; accountId: string } | null = null;
  const lastRead = new Map<string, number>();
  const auth = async () => {
    guard();
    if (token && nowMs() < token.renewAt) return token;
    const assertion = docusignAssertion({
      integrationKey: readSecret("DOCUSIGN_INTEGRATION_KEY", env), userId: readSecret("DOCUSIGN_USER_ID", env), aud: oauthHost,
      privateKeyPem: (() => {
        // The refusal never carries the path.
        try { return fs().readFileSync(readSecret("DOCUSIGN_PRIVATE_KEY_FILE", env), "utf8"); } catch { throw new IntegrationRefused("INTEGRATION_LIVE_DISABLED", "DOCUSIGN_PRIVATE_KEY_FILE could not be read"); }
      })(), nowSec: Math.floor(nowMs() / 1000),
    });
    const res = await f(`https://${oauthHost}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
    if (!res.ok) throw new IntegrationRefused("INTEGRATION_HTTP", `DocuSign token request answered ${res.status} (consent granted for this integration key?)`);
    const t = (await res.json()) as { access_token: string; expires_in?: number };
    const info = await f(`https://${oauthHost}/oauth/userinfo`, { headers: { authorization: `Bearer ${t.access_token}` } });
    if (!info.ok) throw new IntegrationRefused("INTEGRATION_HTTP", `DocuSign userinfo answered ${info.status}`);
    const accountId = readSecret("DOCUSIGN_ACCOUNT_ID", env);
    const acct = ((await info.json()) as { accounts?: { account_id: string; base_uri: string }[] }).accounts?.find((a) => a.account_id === accountId);
    if (!acct) throw new IntegrationRefused("INTEGRATION_HTTP", "DOCUSIGN_ACCOUNT_ID is not one of this user's accounts");
    token = { value: t.access_token, renewAt: nowMs() + ((t.expires_in ?? 3600) - 15 * 60) * 1000, baseUri: acct.base_uri, accountId };
    return token;
  };
  const api = async (method: string, path: string, body?: Json, raw = false) => {
    const t = await auth();
    const res = await f(`${t.baseUri}/restapi/v2.1/accounts/${t.accountId}${path}`, { method, headers: { authorization: `Bearer ${t.value}`, accept: raw ? "application/pdf" : "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new IntegrationRefused("INTEGRATION_HTTP", `DocuSign ${method} ${path.split("?")[0]} answered ${res.status}`);
    return raw ? new Uint8Array(await res.arrayBuffer()) : ((await res.json()) as Json);
  };
  return {
    async status(): Promise<ConnectorStatus> {
      const live = env.WEFT_ESIGN === "docusign" && env.WEFT_LIVE_DOCUSIGN === "1";
      return { vendor: "docusign", category: "esign", mode: "real", configured: true, lastSyncAt: null, cursor: null, health: live ? "ok" : "permission_gap", detail: oauthHost === DOCUSIGN_OAUTH.demo ? "demo" : "production" };
    },
    async send(i) {
      const days = i.expiresOn ? Math.max(1, Math.ceil((Date.parse(`${i.expiresOn}T23:59:59Z`) - nowMs()) / 86_400_000)) : null;
      const r = (await api("POST", "/envelopes", {
        status: "sent", emailSubject: "Your offer documents",
        documents: i.documents.map((d, n) => ({ documentId: String(n + 1), name: d.title, fileExtension: "txt", documentBase64: Buffer.from(d.bytes).toString("base64") })),
        recipients: { signers: [{ recipientId: "1", routingOrder: "1", name: i.signer.name, email: i.signer.email, clientUserId: i.signer.clientUserId,
          tabs: { signHereTabs: i.documents.map((_, n) => ({ documentId: String(n + 1), anchorString: `/weft-sign-${n + 1}/`, anchorUnits: "pixels" })) } }] },
        ...(days ? { notification: { useAccountDefaults: "false", expirations: { expireEnabled: "true", expireAfter: String(days), expireWarn: "0" } } } : {}),
        customFields: { textCustomFields: [{ name: "weft_offer_id", value: i.offerId, show: "false" }] },
      })) as Json;
      return { envelopeId: String(r.envelopeId), status: "sent" as const };
    },
    async signingUrl(envelopeId, signer, returnUrl) {
      if (returnUrl.length > 470) throw new IntegrationRefused("INTEGRATION_HTTP", "returnUrl over 470 characters");
      const r = (await api("POST", `/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`, { returnUrl, authenticationMethod: "None", email: signer.email, userName: signer.name, clientUserId: signer.clientUserId })) as Json;
      return { url: String(r.url), expiresAt: new Date(nowMs() + 300_000).toISOString() };
    },
    async envelope(envelopeId) {
      const last = lastRead.get(envelopeId);
      if (last !== undefined && nowMs() - last < DOCUSIGN_MIN_POLL_MS) throw new IntegrationRefused("INTEGRATION_RATE_GUARD", `DocuSign allows one status read per envelope every 15 minutes`);
      lastRead.set(envelopeId, nowMs());
      const r = (await api("GET", `/envelopes/${encodeURIComponent(envelopeId)}?include=recipients`)) as Json;
      const signers = (((r.recipients as Json | undefined)?.signers as Json[] | undefined) ?? []);
      return { status: String(r.status) as EnvelopeStatus, recipients: signers.map((s) => ({ clientUserId: String(s.clientUserId ?? ""), status: String(s.status) })) };
    },
    async void(envelopeId, reason) { await api("PUT", `/envelopes/${encodeURIComponent(envelopeId)}`, { status: "voided", voidedReason: reason.slice(0, 200) }); },
    async download(envelopeId, which) { return (await api("GET", `/envelopes/${encodeURIComponent(envelopeId)}/documents/${which}`, undefined, true)) as Uint8Array; },
    verifyWebhook(raw: Uint8Array, headers: Record<string, string>): WebhookVerdict {
      let key: string;
      try { key = readSecret("DOCUSIGN_CONNECT_HMAC_KEY", env); } catch { return { ok: false, dedupeKey: null }; }
      return verifyDocusignConnect(raw, headers, key) ? { ok: true, dedupeKey: parseDocusignConnect(raw)[0]?.dedupeKey ?? null } : { ok: false, dedupeKey: null };
    },
    parseWebhook: parseDocusignConnect,
  };
}

/** Swapped in only when the vendor's mode is real; every call still refuses unless WEFT_ESIGN=docusign and WEFT_LIVE_DOCUSIGN=1. */
export function createRealDocusign(env: Env, _simulated: ESignConnector): ESignConnector | null {
  return createDocusignClient({ env });
}
