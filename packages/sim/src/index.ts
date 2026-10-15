// Simulators (SPEC 8). Owner: t2-world. Stateless objects over a db handle, so the executor binds one to its
// transaction: createSimulators({ db: tx, clock }). They write only sim_* tables and store only vault names.
import { NotImplemented, type CarrierSim, type SimClock, type SimEvent, type Simulators } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import { createAgencySim } from "./agency";
import { createBankSim } from "./bank";
import { createChatSim, type ChatSimInternal } from "./chat";
import { createDeviceSim } from "./devices";
import { createFaults } from "./faults";
import { createIdpSim } from "./idp";

export interface CreateSimulatorsOptions { db: DbTx; clock: SimClock }
export type SimulatorsFactory = (opts: CreateSimulatorsOptions) => Simulators;
export interface WeftSimulators extends Simulators { chat: ChatSimInternal }

const carrier: CarrierSim = { invoice: async () => { throw new NotImplemented("carrier invoice simulator (P1)"); } };

export const createSimulators = ((opts: CreateSimulatorsOptions): WeftSimulators => {
  const { db, clock } = opts;
  const faults = createFaults(db);
  const agency = createAgencySim(db, clock, faults);
  const bank = createBankSim(db, clock, faults);
  const idp = createIdpSim(db, clock, faults);
  const devices = createDeviceSim(db, clock, faults);
  const chat = createChatSim(db, clock, faults);
  return {
    agency, bank, idp, devices, chat, carrier, faults,
    async tick(now: string): Promise<SimEvent[]> {
      await idp.tick(now);
      return [...(await agency.tick(now)), ...(await bank.tick(now)), ...(await devices.tick(now))];
    },
  };
}) satisfies SimulatorsFactory;

export { AGENCY_JURISDICTION, AGENCY_LABEL, AGENCY_VAULT, NEEDS_INFO_REASON, REGISTRATION_BUSINESS_DAYS, syntheticAccountNumber } from "./agency";
export { BANK_VAULT } from "./bank";
export { IDP_VAULT } from "./idp";
export { CHAT_CHANNELS, MAX_CHAT_TEXT } from "./chat";
export { DEVICE_CATALOG, catalogItem } from "./devices";
export { SimFaultError } from "./faults";
export { FX_LABEL, FX_USD_PER_UNIT, toUsdCents } from "./fx";
export { SCENARIOS, fixtureText, renderScenarioAt, type RenderedNotice } from "./notices/scenarios";
export { parseNotice, percentToRate, parseDate } from "./notices/parser";
export { addBusinessDays, addDays, ptDate, isWeekendPt } from "./time";
