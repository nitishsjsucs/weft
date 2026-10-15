// Names of record (SPEC 0 rule 1): every displayed person or company name ends with "(demo)".
export const DEMO_SUFFIX = " (demo)";

export function displayName(first: string, last: string): string {
  return `${first} ${last}${DEMO_SUFFIX}`;
}

/** Readable reference with a short id, the concise read format: "Imani Ferreira (demo) (wrk_0004)". */
export function nameRef(first: string, last: string, id: string): string {
  return `${displayName(first, last)} (${id})`;
}

/** Lowercase ASCII slug of a name part: "Okonkwo Lind" gives "okonkwolind". */
export function slugPart(s: string): string {
  return s.normalize("NFKD").replace(/[^A-Za-z]/g, "").toLowerCase();
}

export function workEmail(first: string, last: string, domain = "larkspur.example"): string {
  return `${slugPart(first)}.${slugPart(last)}@${domain}`;
}
