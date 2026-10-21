// SQLite result codes by number (sqlite.org/rescode.html), for the emulator's workerd-shaped messages and the
// facade's error mapping. workerd ends every SQL error message with ": <PRIMARY>" and, when the extended code
// differs, " (extended: <EXTENDED>)" (verified locally in Miniflare 5.20261019.1-beta).

const PRIMARY: Record<number, string> = {
  0: "SQLITE_OK", 1: "SQLITE_ERROR", 2: "SQLITE_INTERNAL", 3: "SQLITE_PERM", 4: "SQLITE_ABORT", 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM", 8: "SQLITE_READONLY", 9: "SQLITE_INTERRUPT", 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT", 12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL", 14: "SQLITE_CANTOPEN", 15: "SQLITE_PROTOCOL", 16: "SQLITE_EMPTY", 17: "SQLITE_SCHEMA", 18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT", 20: "SQLITE_MISMATCH", 21: "SQLITE_MISUSE", 22: "SQLITE_NOLFS", 23: "SQLITE_AUTH", 24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE", 26: "SQLITE_NOTADB", 27: "SQLITE_NOTICE", 28: "SQLITE_WARNING",
};

const EXTENDED: Record<number, string> = {
  257: "SQLITE_ERROR_MISSING_COLLSEQ", 513: "SQLITE_ERROR_RETRY", 769: "SQLITE_ERROR_SNAPSHOT", 261: "SQLITE_BUSY_RECOVERY",
  517: "SQLITE_BUSY_SNAPSHOT", 773: "SQLITE_BUSY_TIMEOUT", 262: "SQLITE_LOCKED_SHAREDCACHE", 518: "SQLITE_LOCKED_VTAB",
  264: "SQLITE_READONLY_RECOVERY", 520: "SQLITE_READONLY_CANTLOCK", 776: "SQLITE_READONLY_ROLLBACK", 1032: "SQLITE_READONLY_DBMOVED",
  516: "SQLITE_ABORT_ROLLBACK", 275: "SQLITE_CONSTRAINT_CHECK", 531: "SQLITE_CONSTRAINT_COMMITHOOK", 787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1043: "SQLITE_CONSTRAINT_FUNCTION", 1299: "SQLITE_CONSTRAINT_NOTNULL", 1555: "SQLITE_CONSTRAINT_PRIMARYKEY", 1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE", 2323: "SQLITE_CONSTRAINT_VTAB", 2579: "SQLITE_CONSTRAINT_ROWID", 2835: "SQLITE_CONSTRAINT_PINNED",
  3091: "SQLITE_CONSTRAINT_DATATYPE", 279: "SQLITE_AUTH_USER",
};

export interface SqliteCodes { code: string; extendedCode: string; rawCode: number }

/** Primary and extended code names for a (possibly extended) numeric result code. */
export function codesOf(raw: number): SqliteCodes {
  const primary = PRIMARY[raw & 0xff] ?? `SQLITE_UNKNOWN_${raw & 0xff}`;
  return { code: primary, extendedCode: EXTENDED[raw] ?? primary, rawCode: raw };
}

/** workerd's suffix for a result code: ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)". */
export function workerdSuffix(raw: number): string {
  const c = codesOf(raw);
  return c.extendedCode !== c.code ? `: ${c.code} (extended: ${c.extendedCode})` : `: ${c.code}`;
}

const SUFFIX = /: (SQLITE_[A-Z_]+)(?: \(extended: (SQLITE_[A-Z_]+)\))?$/;

/** Parses workerd's message suffix back into codes; null when the message carries none. */
export function parseWorkerdSuffix(message: string): { message: string; code: string; extendedCode: string } | null {
  const m = SUFFIX.exec(message);
  if (!m) return null;
  return { message: message.slice(0, m.index), code: m[1]!, extendedCode: m[2] ?? m[1]! };
}
