// Copied verbatim from research/harness.md section 13 (memory.ts).
export type MemoryDocType = "person" | "team" | "company" | "agency" | "vendor" | "thread" | "timeline_raw" | "timeline_hourly"
  | "timeline_daily" | "timeline_weekly" | "timeline_monthly" | "workstream" | "fact" | "procedure" | "preference" | "decision";
export interface MemoryFrontmatter { id: string; type: MemoryDocType; aliases: string[]; links: string[]; sources: string[]; status: string | null; updated: string; taintedBy: string | null }
export interface MemoryHit { path: string; line: number; snippet: string; commit: string; date: string; cite: string; taintedBy: string | null }
export interface MemoryWrite { path: string; frontmatter: MemoryFrontmatter; body: string; message: string; author: { name: string; email: string } }
export const MODEL_WRITE_PREFIXES = ["knowledge/procedures/", "knowledge/facts/", "workstreams/"] as const;
export const MODEL_WRITE_DENY = ["knowledge/facts/company-onepager.md"] as const;
export type MemoryFolder = "entities" | "comms" | "timeline" | "workstreams" | "knowledge";

export interface MemoryStore {                 // local impl: git CLI hardened per harness 6.7; hosted impl P1
  init(companyId: string): Promise<void>;
  head(): Promise<string>;
  read(path: string, at?: string): Promise<{ frontmatter: MemoryFrontmatter; body: string } | null>;
  search(q: { query: string; folders: MemoryFolder[] | null; at: string | null; limit: number }): Promise<MemoryHit[]>;
  write(w: MemoryWrite): Promise<{ commit: string }>;          // path rules, PII and secret refusals
  appendTimeline(b: { at: string; command: string; text: string; importance: 0 | 1 | 2 | 3; source: string; chainHead: { seq: number; hash: string } }): Promise<{ commit: string }>;
  remove(path: string, message: string): Promise<{ commit: string }>;   // P1, human only
  tree(prefix?: string): Promise<string[]>;
}
