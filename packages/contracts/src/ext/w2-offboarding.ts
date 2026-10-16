// w2-offboarding additive contract (docs/wave2.md rule 2). Additive only; the integrator folds it into sim.ts.
// The simulators implement these today (packages/sim/src/idp.ts and devices.ts); core reads them through optional
// methods (packages/core/src/offboarding/steps.ts), so nothing else changes until they are folded in.
import type { DeviceSim, IdpSim } from "../sim";

/** IdpSim gains clearGroups (fault target idp.clearGroups); suspend now checks the fault target idp.suspend. */
export interface W2OffboardingIdpSim extends IdpSim { clearGroups(ref: string): Promise<{ removed: string[] }> }

/** DeviceSim gains a remote lock (fault target devices.lock). The lock reference and time are the receipt. */
export interface W2OffboardingDeviceSim extends DeviceSim { lock(req: { workerId: string; deviceId: string; reason: string }): Promise<{ lockRef: string; lockedAt: string }> }
