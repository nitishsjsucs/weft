// Ephemeral read ids (docs/cloudflare/design.md 4.4): a read outside a run returns `res_e_` and 16 random hex digits
// instead of minting a counter id, so page GETs and MCP reads write no rows. The prefix is disjoint from every
// counter id (res_0001 and up), so no persisted id can collide after an eviction.
import { randomBytes } from "node:crypto";
import { EPHEMERAL_READ_ID_PREFIX } from "../../../contracts/src/ext/cf-platform";

export const EPHEMERAL_READ_ID = /^res_e_[0-9a-f]{16}$/;

export function ephemeralReadId(): string {
  return `${EPHEMERAL_READ_ID_PREFIX}${randomBytes(8).toString("hex")}`;
}
