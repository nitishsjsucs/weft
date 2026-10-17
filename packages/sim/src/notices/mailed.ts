// Mailed notice samples and their extraction sidecars (wave 4 T4, owner w4-parity-compliance). A person uploads a
// scan of a mailed agency notice; Weft does no OCR and makes no model call. Instead each sample file in mailed/ has a
// sidecar JSON with the fields a scanning service would return, including a confidence. Extraction is a lookup by the
// sha256 of the uploaded bytes, so an unknown file extracts nothing and goes to a person.
//
// The samples also deliver the notice kinds the simulator has no scenario for (late deposit penalty, FUTA credit
// reduction, benefit charge, an unknown kind and a smudged scan) without inserting rows by hand.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** What the sidecar says. `kind` is free text on purpose: an upload may be a kind Weft does not handle. */
export interface UploadExtract {
  agency: string; kind: string; formCode: string; title: string; accountNumber: string | null; taxYear: number | null;
  period: string | null; effectiveFrom: string | null; respondBy: string | null; amountCents: number | null;
  /** 0 to 1. Below MIN_EXTRACT_CONFIDENCE (0.9) the notice goes to a tax specialist. */
  confidence: number;
}

export interface MailedSample { name: string; fileName: string; path: string; sha256: string; text: string; extract: UploadExtract }

const DIR = fileURLToPath(new URL("./mailed/", import.meta.url));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Validates a sidecar strictly; a malformed one is treated as no extraction at all. */
export function parseSidecar(v: unknown): UploadExtract | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string, max = 80) => (typeof o[k] === "string" && (o[k] as string).length <= max ? (o[k] as string) : null);
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
  const d = (k: string) => { const x = s(k, 10); return x && DATE.test(x) ? x : null; };
  const agency = s("agency", 20), kind = s("kind", 40), formCode = s("formCode", 20), title = s("title", 120), confidence = n("confidence");
  if (!agency || !kind || !/^[a-z_]+$/.test(kind) || formCode === null || title === null || confidence === null || confidence < 0 || confidence > 1) return null;
  const amount = n("amountCents");
  const year = n("taxYear");
  return {
    agency, kind, formCode, title, accountNumber: s("accountNumber", 30), taxYear: year !== null && Number.isInteger(year) ? year : null,
    period: s("period", 12), effectiveFrom: d("effectiveFrom"), respondBy: d("respondBy"), amountCents: amount !== null && Number.isInteger(amount) ? amount : null, confidence,
  };
}

let cache: MailedSample[] | null = null;
/** Every sample in mailed/ with a valid sidecar, by name. */
export function mailedSamples(): MailedSample[] {
  if (cache) return cache;
  const out: MailedSample[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".txt")).sort()) {
    const name = f.slice(0, -4);
    const path = join(DIR, f);
    const bytes = readFileSync(path);
    let extract: UploadExtract | null = null;
    try { extract = parseSidecar(JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"))); } catch { extract = null; }
    if (extract) out.push({ name, fileName: f, path, sha256: sha(bytes), text: bytes.toString("utf8"), extract });
  }
  cache = out;
  return out;
}

/** The sidecar for uploaded bytes (by sha256), or null when the file is not a known sample. */
export function extractUpload(sha256: string): { sample: string; text: string; extract: UploadExtract } | null {
  const s = mailedSamples().find((x) => x.sha256 === sha256);
  return s ? { sample: s.name, text: s.text, extract: s.extract } : null;
}
