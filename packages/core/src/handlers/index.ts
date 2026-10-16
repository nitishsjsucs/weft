// Scaffold (frozen): concatenates the per-domain handler arrays, run by the scheduler in event order as svc_ principals.
import type { EventHandler } from "@weft/contracts";
import { payrollHandlers } from "../payroll/handlers";
import { onboardingHandlers } from "../onboarding/handlers";
import { taxHandlers } from "../tax/handlers";
import { expensesHandlers } from "../expenses/handlers";
import { timeOffHandlers } from "../time-off/handlers";
import { integrationsHandlers } from "../integrations/handlers";

export const handlers: EventHandler[] = [...payrollHandlers, ...onboardingHandlers, ...taxHandlers, ...expensesHandlers, ...timeOffHandlers, ...integrationsHandlers];   // wave 3 after the wave 1 three
