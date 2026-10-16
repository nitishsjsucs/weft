// The email simulator (wave 2, docs/wave2.md). Owner: w2-onboarding. An outbox over sim_email_messages: offer and
// portal invites, onboarding nudges, COBRA notices. Only *.example addresses; nothing leaves the process.
import { and, asc, eq } from "drizzle-orm";
import type { EmailMessage, EmailSim, FaultInjector, SimClock } from "@weft/contracts";
import { simEmailMessages, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const MAX_EMAIL_BODY = 20_000;
const EXAMPLE_ADDR = /^[^@\s]+@([a-z0-9-]+\.)*example$/i;

export function createEmailSim(db: DbTx, clock: SimClock, faults: FaultInjector): EmailSim {
  return {
    async send(msg) {
      const fault = await firstFault(faults, ["email.send"]);
      if (fault === "error") throw new SimFaultError("email.send");
      if (!EXAMPLE_ADDR.test(msg.to) || !EXAMPLE_ADDR.test(msg.from)) throw new Error("email.send: only *.example addresses");
      if (msg.subject.length === 0 || msg.subject.length > 200) throw new Error("email.send: subject must be 1 to 200 characters");
      if (msg.body.length > MAX_EMAIL_BODY) throw new Error("email.send: body over 20000 characters");
      const id = await mintId(db, "eml_");
      await db.insert(simEmailMessages).values({ id, toAddr: msg.to, fromAddr: msg.from, subject: msg.subject, body: msg.body, kind: msg.kind, relatedRef: msg.relatedRef, ts: clock.now() });
      return { id };
    },
    async list(to) {
      const rows = await db.select().from(simEmailMessages).where(to ? and(eq(simEmailMessages.toAddr, to)) : undefined).orderBy(asc(simEmailMessages.id));
      return rows.map((r): EmailMessage => ({ id: r.id, to: r.toAddr, from: r.fromAddr, subject: r.subject, body: r.body, kind: r.kind as EmailMessage["kind"], relatedRef: r.relatedRef, ts: r.ts }));
    },
  };
}
