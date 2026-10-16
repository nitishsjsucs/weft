// w2-benefits-contractors additive contract (docs/wave2.md rule 2). Additive only; the integrator may export it from
// packages/contracts/src/index.ts. The route table names these response shapes ("OpenEnrollmentRow[]", "FxRate[]")
// without defining them; these are the shapes the API serves.
import { z } from "zod";
import { OpenEnrollmentStatus } from "../wave2";

/** GET /v1/benefits/open-enrollment: one row per eligible employee for the plan year. */
export const W2BenefitsOpenEnrollmentRow = z.object({
  id: z.string().startsWith("oen_"), workerId: z.string().startsWith("wrk_"), name: z.string(), planYear: z.number().int(),
  status: OpenEnrollmentStatus, nudges: z.number().int().min(0), lastNudgedAt: z.string().nullable(), electedAt: z.string().nullable(),
});
export type W2BenefitsOpenEnrollmentRow = z.infer<typeof W2BenefitsOpenEnrollmentRow>;

/** GET /v1/contractors/fx: the fixed synthetic FX table (USD per unit as a decimal string). */
export const W2BenefitsFxRate = z.object({ currency: z.string().length(3), usdPerUnit: z.string().regex(/^\d+(\.\d+)?$/), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: z.string() });
export type W2BenefitsFxRate = z.infer<typeof W2BenefitsFxRate>;
