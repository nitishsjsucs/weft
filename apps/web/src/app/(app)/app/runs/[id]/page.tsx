import { RunView } from "@/components/app/runs/run-view";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView id={id} />;
}
