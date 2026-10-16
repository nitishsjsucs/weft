import { PageHeader } from "@/components/app/page";
import { AgentSettingsCard } from "@/components/app/routines/agent-settings";

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Settings" subtitle="Company settings for the agent. Permissions and API keys come next." />
      <AgentSettingsCard />
    </div>
  );
}
