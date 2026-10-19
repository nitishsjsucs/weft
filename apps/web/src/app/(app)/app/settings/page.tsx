import Link from "next/link";
import { PageHeader } from "@/components/app/page";
import { AgentSettingsCard } from "@/components/app/routines/agent-settings";

const MORE: { href: string; title: string; body: string }[] = [
  { href: "/app/settings/permissions", title: "Permissions", body: "Who can view, edit or approve in each domain, and what the agent may do without asking." },
  { href: "/app/integrations", title: "Integrations", body: "Greenhouse, Workday, background checks and e-signature, each simulated until a real account is connected." },
  { href: "/app/routines", title: "Routines", body: "Scheduled and event-driven agent work, with its autonomy level and run history." },
];

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Settings" subtitle="Company settings for the agent, and where the rest of the configuration lives." />
      <AgentSettingsCard />
      <div className="mt-6 grid gap-3 tablet:grid-cols-3" data-testid="settings-more">
        {MORE.map((m) => (
          <Link key={m.href} href={m.href} className="rounded-lg border border-[var(--app-border)] p-4 hover:bg-gray-2">
            <div className="text-2 font-medium">{m.title}</div>
            <div className="mt-1 text-1 text-gray-10">{m.body}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
