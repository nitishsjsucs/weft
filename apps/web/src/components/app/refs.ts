import { PRINCIPALS } from "@/lib/api/hooks";

/** Where an evidence or subject ref lives in the app. Unknown refs render as plain text. */
export function refHref(ref: string): string | null {
  if (ref.startsWith("ntc_")) return `/app/compliance?notice=${ref}`;
  if (ref.startsWith("pay_")) return `/app/payroll/${ref}`;
  if (ref.startsWith("wrk_")) return `/app/people/${ref}`;
  if (ref.startsWith("run_")) return `/app/runs/${ref}`;
  if (ref.startsWith("rt_")) return `/app/routines/${ref}`;
  if (ref.startsWith("etr_") || ref.startsWith("txa_")) return "/app/compliance";
  if (/^(act_|seq:|action:)/.test(ref)) return "/app/audit";
  return null;
}

export function principalName(id: string | null | undefined): string {
  if (!id) return "-";
  const p = PRINCIPALS.find((x) => x.id === id);
  if (p) return p.name;
  if (id.startsWith("agt_")) return "Weft agent";
  if (id.startsWith("svc_")) return `System (${id.slice(4)})`;
  return id;
}
