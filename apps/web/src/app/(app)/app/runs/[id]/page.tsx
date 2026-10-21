import { RunRoute } from "@/components/app/route-shells";
import { shellStaticParams } from "@/lib/static-export";

export const generateStaticParams = shellStaticParams;

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunRoute id={id} />;
}
