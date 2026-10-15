import { parseEventBody, type EventBody, type SimClock, type WeftEvent } from "@weft/contracts";
import { events, type DbTx } from "@weft/db";
import { newId } from "./ids";

export interface EmitInput { body: EventBody; subjectRef: string; attended: boolean; requestedBy: string | null }

/** Validates the id-only payload against contracts/events.ts and appends an events row. Returns the stored event. */
export async function emitEvent(tx: DbTx, clock: Pick<SimClock, "now">, input: EmitInput): Promise<WeftEvent> {
  const body = parseEventBody(input.body);
  const id = await newId(tx, "evt_");
  const evt: WeftEvent = {
    id, type: body.type, ts: clock.now(), subjectRef: input.subjectRef,
    payload: body.payload as Record<string, string>, attended: input.attended, requestedBy: input.requestedBy,
  };
  await tx.insert(events).values({
    id: evt.id, type: evt.type, ts: evt.ts, subjectRef: evt.subjectRef, payloadJson: JSON.stringify(evt.payload),
    attended: evt.attended, requestedBy: evt.requestedBy, consumedJson: "[]",
  });
  return evt;
}
