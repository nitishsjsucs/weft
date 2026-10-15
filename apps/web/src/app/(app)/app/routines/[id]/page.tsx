import { RoutineDetail } from "@/components/app/routines/routines-view";

export default async function RoutinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoutineDetail id={id} />;
}
