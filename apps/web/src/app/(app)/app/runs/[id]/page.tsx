import { Placeholder } from "@/components/app/page";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Placeholder title={`Run ${id}`} note="Stage rows with tokens, cache-hit ratio, USD and model time arrive in round 2." />;
}
