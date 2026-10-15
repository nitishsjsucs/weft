// Scaffold (frozen): concatenates the per-domain handler arrays, run by the scheduler in event order as svc_ principals.
import type { EventHandler } from "@weft/contracts";
import { payrollHandlers } from "../payroll/handlers";
import { onboardingHandlers } from "../onboarding/handlers";
import { taxHandlers } from "../tax/handlers";

export const handlers: EventHandler[] = [...payrollHandlers, ...onboardingHandlers, ...taxHandlers];
