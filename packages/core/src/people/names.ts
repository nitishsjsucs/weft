// Names of record: a person's first and last name as the seed or the record holds them, with no suffix.

export function displayName(first: string, last: string): string {
  return `${first} ${last}`;
}

/** Readable reference with a short id, the concise read format: "Imani Ferreira (wrk_0004)". */
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
