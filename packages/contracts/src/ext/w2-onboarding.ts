// Additive contracts for w2-onboarding (docs/wave2.md rule 2). Export names carry the W2Onboarding prefix.
// Re-exported through w2/testids-onboarding.ts, which the frozen index already exports.
import { z } from "zod";
import { DocumentKind, DocumentStatus, OfferLifecycle, PortalView } from "../wave2";

/** An offer as the offer builder shows it: the wave 1 Offer fields plus the wave 2 lifecycle columns. */
export const W2OnboardingOfferDetail = z.object({
  id: z.string(), candidateFirst: z.string(), candidateLast: z.string(), candidateEmail: z.string(), title: z.string(),
  departmentId: z.string(), workplaceId: z.string(), workState: z.string(), managerId: z.string().nullable(),
  baseCents: z.number().int(), payKind: z.string(), startDate: z.string(), status: OfferLifecycle, acceptedAt: z.string().nullable(), workerId: z.string().nullable(),
  createdAt: z.string().nullable(), sentAt: z.string().nullable(), viewedAt: z.string().nullable(), voidedAt: z.string().nullable(),
  expiresOn: z.string().nullable(), documentId: z.string().nullable(), personaPrincipalId: z.string().nullable(),
  allowed: z.array(OfferLifecycle),
});
export type W2OnboardingOfferDetail = z.infer<typeof W2OnboardingOfferDetail>;

/** A document the new hire can read and sign: the body text and the sha256 the signature must carry. */
export const W2OnboardingSignable = z.object({ id: z.string(), kind: DocumentKind, title: z.string(), status: DocumentStatus, sha256: z.string(), bodyText: z.string(), signedAt: z.string().nullable() });
export type W2OnboardingSignable = z.infer<typeof W2OnboardingSignable>;

/** GET /v1/portal/me: the frozen PortalView plus what the portal screens need to render each task. */
export const W2OnboardingPortalView = PortalView.extend({
  offer: z.object({ id: z.string(), status: OfferLifecycle, title: z.string(), baseCents: z.number().int(), payKind: z.string(), startDate: z.string(), expiresOn: z.string().nullable(), candidateEmail: z.string() }).nullable(),
  signer: z.object({ principalId: z.string(), legalName: z.string() }),
  documents: z.array(W2OnboardingSignable),
  stateForm: z.object({ form: z.string(), title: z.string() }).nullable(),
  plans: z.array(z.object({ id: z.string(), type: z.string(), name: z.string(), carrier: z.string(), tierPrices: z.record(z.string(), z.number()), deferral: z.object({ minBps: z.number(), maxBps: z.number() }).nullable() })),
  bank: z.object({ bankName: z.string(), routingLast4: z.string(), accountLast4: z.string(), status: z.string() }).nullable(),
  w4: z.object({ filingStatus: z.string(), source: z.string() }).nullable(),
  upload: z.object({ id: z.string(), fileName: z.string(), bytes: z.number(), sha256: z.string(), masked: z.literal(true), preview: z.string() }).nullable(),
  workerStatus: z.string().nullable(),
});
export type W2OnboardingPortalView = z.infer<typeof W2OnboardingPortalView>;
