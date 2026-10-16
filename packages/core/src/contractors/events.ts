// Wave 2 event rows for this track (benefits.invoice_received, sim.rail_delivered). The frozen EventBody union and
// emitEvent() do not accept wave 2 types, so these are validated against Wave2EventBody and appended directly.
import { Wave2EventBody } from "@weft/contracts";
import { events, type DbTx } from "@weft/db";
import { newId } from "../shared/ids";

export async function emitWave2Event(tx: DbTx, now: string, body: Wave2EventBody, subjectRef: string, stamp: { attended: boolean; requestedBy: string | null }): Promise<string> {
  const parsed = Wave2EventBody.parse(body);
  const id = await newId(tx, "evt_");
  await tx.insert(events).values({ id, type: parsed.type, ts: now, subjectRef, payloadJson: JSON.stringify(parsed.payload), attended: stamp.attended, requestedBy: stamp.requestedBy, consumedJson: "[]" });
  return id;
}
