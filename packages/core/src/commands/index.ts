// Scaffold (frozen): concatenates the per-file command arrays. Tracks edit only their own files.
import type { WeftCommand } from "../shared/deps";
import { payrollCommands } from "./payroll";
import { peopleCommands } from "./people";
import { taxCommands } from "./tax";
import { noticesCommands } from "./notices";
import { benefitsCommands } from "./benefits";
import { itCommands } from "./it";
import { commsCommands } from "./comms";
import { onboardingCommands } from "./onboarding";
import { demoCommands } from "./demo";
import { routinesCommands } from "./routines";
import { documentsCommands } from "./documents";
import { offboardingCommands } from "./offboarding";
import { contractorsCommands } from "./contractors";
import { expensesCommands } from "./expenses";
import { timeOffCommands } from "./time-off";
import { reportsCommands } from "./reports";
import { integrationsCommands } from "./integrations";
import { screeningCommands } from "./screening";
import { parityCommands } from "./parity";

export const commands: WeftCommand[] = [
  ...payrollCommands, ...peopleCommands, ...taxCommands, ...noticesCommands, ...benefitsCommands,
  ...itCommands, ...commsCommands, ...onboardingCommands, ...demoCommands, ...routinesCommands,
  ...documentsCommands, ...offboardingCommands, ...contractorsCommands,   // wave 2
  ...expensesCommands, ...timeOffCommands, ...reportsCommands, ...integrationsCommands, ...screeningCommands, ...parityCommands,   // wave 3
];
