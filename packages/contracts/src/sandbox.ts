// Copied verbatim from research/harness.md section 13 (sandbox.ts).
export interface CodeRunInput { language: "js"; source: string; purpose: string; inputs: unknown | null }
export interface CodeRunLimits { heapBytes: number; stackBytes: number; cpuMs: number; wallMs: number; maxCalls: number; maxCallBytes: number; maxValueBytes: number; maxLogBytes: number }
export const DEFAULT_CODE_LIMITS: CodeRunLimits = { heapBytes: 32 << 20, stackBytes: 512 << 10, cpuMs: 2000, wallMs: 10000, maxCalls: 25, maxCallBytes: 256 << 10, maxValueBytes: 64 << 10, maxLogBytes: 8 << 10 };
export interface CodeRunResult {
  ok: boolean; value: unknown | null; artifactRef: string | null; logs: string; tainted: boolean;   // OR of inner calls
  calls: { command: string; outcome: string; ms: number }[];
  error: { code: "SANDBOX_TIMEOUT" | "SANDBOX_OOM" | "SANDBOX_ERROR" | "CALL_BUDGET"; message: string } | null;
  memoryAt: string;
}
export interface SandboxEngine { id: "quickjs" | "microvm" | "worker_loader"; run(input: CodeRunInput, limits: CodeRunLimits, call: (name: string, args: unknown) => Promise<unknown>): Promise<CodeRunResult> }
