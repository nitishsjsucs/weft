"use client";
// A routine run named by its routine, wherever a page says who did something ("Routine: Agency notice handling").
import { useEffect, useRef, useState } from "react";
import { client, useGet } from "@/lib/api/hooks";

/** The routines' names for the routine runs on the page, read once per run id. */
export function useRoutineNames(runIds: string[]): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const routines = useGet("/v1/routines", { enabled: runIds.length > 0 });
  const key = runIds.join(",");
  useEffect(() => {
    const defs = (routines.data ?? []) as { id: string; name: string }[];
    if (!defs.length) return;
    for (const id of runIds) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      client.get("/v1/routine-runs/:id", { params: { id } }).then(
        (r) => { const name = defs.find((d) => d.id === (r as { routineId: string }).routineId)?.name; if (name) setNames((n) => ({ ...n, [id]: name })); },
        () => undefined,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, routines.data]);
  return names;
}

