import { AgentPage } from "@/components/app/agent-page/agent-page";

// The full-page agent: conversations, background work and the selected conversation. The selection is in the query
// (?thread= or ?run=), so the static export builds this one page and needs no shell for it.
export default function AgentRoute() {
  return <AgentPage />;
}
