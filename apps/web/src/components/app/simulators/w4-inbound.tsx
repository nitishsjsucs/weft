"use client";
// Simulators panel controls for inbound chat and email (wave 4, w4-parity-agent, Q6 and S5). Owner: w4-parity-agent.
// "Post as" types a message into a simulated channel as a fictional person; naming @weft starts a tainted, read-only
// run that answers once in the thread. "Email a receipt" delivers an expense email to the simulated expenses inbox from
// any address with one of the receipt fixtures; only a worker's work address on file files an expense.
// Mounted in simulators-view.tsx (contract request: one line).
import { useState, type FormEvent, type ReactNode } from "react";
import { AtSign, Inbox } from "lucide-react";
import { Badge, Button, Card, CardHeading } from "@weft/ui/components";
import { client, errorText, invalidate, PRINCIPALS, useGet, useMutation } from "@/lib/api/hooks";
import { useAgent } from "../agent-context";
import { fmtDateTime, statusLabel } from "../format";
import { principalName } from "../refs";

/** The people a message can be posted as: the demo personas by name and role (the form sends the id). */
const ROLE_WORDS: Record<string, string> = { admin: "admin", payroll_admin: "payroll admin", hr_manager: "HR manager", manager: "manager" };
const POSTERS = PRINCIPALS.map((p) => ({ id: p.id, label: `${p.name}, ${ROLE_WORDS[p.role] ?? p.role.replaceAll("_", " ")}` }));
/** A mention's status as words. */
const MENTION_STATUS: Record<string, string> = { queued: "Queued", running: "Answering", answered: "Answered", refused: "Refused", ignored: "Ignored" };

const CHANNELS = ["#people-ops", "#payroll", "#new-hires", "#general", "#leadership"] as const;
const FIXTURES = [
  { key: "lunch_client", label: "Client lunch, $64.20" }, { key: "taxi_airport", label: "Airport taxi, $48.75" },
  { key: "hotel_two_nights", label: "Hotel, two nights, $218.00" }, { key: "software_monthly", label: "Software plan, $18.00" },
] as const;
const field = "h-9 w-full rounded-lg border border-[var(--app-border)] bg-card px-3 text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-1 text-gray-11">{label}{children}</label>;
}

type Mention = { id: string; channel: string; status: string; runId: string | null; mentionedBy?: string; createdAt?: string };
type Intake = { id: string; fromAddress: string; status: string; expenseId: string | null };

export function SimInboundControls() {
  const agent = useAgent();
  const mentions = useGet("/v1/agent/mentions", { refreshMs: 4_000 }) as unknown as { data: Mention[] | undefined };
  const intake = useGet("/v1/expense-intake", { refreshMs: 4_000 }) as unknown as { data: Intake[] | undefined };
  const [chat, setChat] = useState({ channel: "#payroll" as (typeof CHANNELS)[number], from: "usr_theo", text: "@weft what is the status of the draft payroll?" });
  const [mail, setMail] = useState({ from: "", subject: "Client lunch", body: "Lunch with the pilot customer to plan the rollout.", fixture: "lunch_client" as string });
  const [note, setNote] = useState<string | null>(null);

  const post = useMutation(async () => {
    const r = (await client.post("/v1/sim/chat/inbound", { body: chat })) as unknown as { messageRef: string; mentionId: string | null; runId?: string };
    setNote(r.mentionId ? (r.runId ? `Posted in ${chat.channel}. The agent is answering in the thread (read only).` : `Posted in ${chat.channel}. The agent did not take this one.`) : `Posted in ${chat.channel}; it does not tag @weft, so the agent stays out.`);
    if (r.runId) agent.watch(r.runId, `Chat mention in ${chat.channel}`);
    invalidate();
    return r;
  });
  const email = useMutation(async () => {
    const body = { from: mail.from.trim(), subject: mail.subject, body: mail.body, attachment: mail.fixture ? { fileName: `${mail.fixture}.pdf`, fixture: mail.fixture } : null };
    const r = (await client.post("/v1/sim/email/inbound", { body })) as unknown as { intakeId: string | null; status: string; expenseId?: string | null };
    const receipt = FIXTURES.find((f) => f.key === mail.fixture)?.label;
    setNote(r.expenseId ? `Filed an expense claim from the email${receipt ? ` (${receipt})` : ""}. It is on the Expenses page.` : `The email was not filed: ${statusLabel(r.status).toLowerCase()}.`);
    invalidate();
    return r;
  });
  const err = post.error ?? email.error;
  const onChat = (e: FormEvent) => { e.preventDefault(); void post.run(); };
  const onMail = (e: FormEvent) => { e.preventDefault(); void email.run(); };

  return (
    <>
      <section className="min-w-0">
        <CardHeading icon={<AtSign />}>Post in a channel</CardHeading>
        <Card className="p-4" data-testid="sim-inbound-chat">
          <form onSubmit={onChat} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Channel"><select className={field} value={chat.channel} onChange={(e) => setChat({ ...chat, channel: e.target.value as (typeof CHANNELS)[number] })}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Post as"><select data-testid="sim-inbound-chat-from" className={field} value={chat.from} onChange={(e) => setChat({ ...chat, from: e.target.value })}>{POSTERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
            </div>
            <Field label="Message (tag @weft to ask the agent)"><input data-testid="sim-inbound-chat-text" className={field} maxLength={4000} value={chat.text} onChange={(e) => setChat({ ...chat, text: e.target.value })} /></Field>
            <div><Button type="submit" size="sm" disabled={post.pending || !chat.text.trim()} data-testid="sim-inbound-chat-send">{post.pending ? "Posting..." : "Post message"}</Button></div>
          </form>
          <ul className="mt-3 flex flex-col gap-1 text-1 text-gray-11" data-testid="sim-mentions">
            {(mentions.data ?? []).slice(0, 5).map((m) => <li key={m.id} className="flex flex-wrap items-center gap-x-2"><span className="font-medium text-gray-12">{m.channel}</span>{m.mentionedBy ? <span>{principalName(m.mentionedBy)}</span> : null}{m.createdAt ? <span className="text-gray-10">{fmtDateTime(m.createdAt)}</span> : null} <Badge tone="outline">{MENTION_STATUS[m.status] ?? statusLabel(m.status)}</Badge></li>)}
          </ul>
        </Card>
      </section>
      <section className="min-w-0">
        <CardHeading icon={<Inbox />}>Email a receipt</CardHeading>
        <Card className="p-4" data-testid="sim-inbound-email">
          <form onSubmit={onMail} className="flex flex-col gap-3">
            <Field label="From (a work address files; anything else bounces)"><input data-testid="sim-inbound-email-from" className={field} placeholder="name@larkspur.example" value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} /></Field>
            <Field label="Subject"><input className={field} maxLength={200} value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} /></Field>
            <Field label="Receipt"><select className={field} value={mail.fixture} onChange={(e) => setMail({ ...mail, fixture: e.target.value })}><option value="">No attachment</option>{FIXTURES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></Field>
            <div><Button type="submit" size="sm" disabled={email.pending || !mail.from.includes("@")} data-testid="sim-inbound-email-send">{email.pending ? "Sending..." : "Send email"}</Button></div>
          </form>
          <ul className="mt-3 flex flex-col gap-1 text-1 text-gray-11" data-testid="sim-intake">
            {(intake.data ?? []).slice(0, 5).map((x) => <li key={x.id} className="flex items-center gap-2"><span className="truncate">{x.fromAddress}</span> <Badge tone="outline">{statusLabel(x.status)}</Badge></li>)}
          </ul>
        </Card>
      </section>
      {note || err ? <p role={err ? "alert" : undefined} className={err ? "text-1 text-red-11 laptop:col-span-2" : "text-1 text-green-11 laptop:col-span-2"}>{err ? errorText(err) : note}</p> : null}
    </>
  );
}
