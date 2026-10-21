import { RoutineRoute } from "@/components/app/route-shells";
import { shellStaticParams } from "@/lib/static-export";

export const generateStaticParams = shellStaticParams;

export default async function RoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoutineRoute id={id} />;
}
