// SQL text helpers shared by the durable facade and the node:sqlite emulator (docs/cloudflare/design.md 4.2 and 11.2).
// A small tokenizer that knows SQLite's quoting and comments: it splits a script into statements (keeping a trigger's
// BEGIN ... END body whole), counts and rewrites `?` placeholders, and names a statement's leading keywords. It never
// parses SQL beyond that, so it stays cheap enough to run on every statement.

export interface SqlToken {
  kind: "word" | "string" | "ident" | "param" | "punct" | "space" | "comment";
  text: string;
  start: number;
}

const WORD = /[A-Za-z0-9_$\u0080-￿]/;

const cache = new Map<string, SqlToken[]>();
const CACHE_MAX = 4096;

/** Splits SQL text into tokens (memoized: drizzle sends the same statement texts again and again). Unterminated
 * quotes and comments run to the end of the text, as SQLite reads them. */
export function tokenize(sql: string): SqlToken[] {
  const hit = cache.get(sql);
  if (hit) return hit;
  const out = scan(sql);
  if (sql.length <= 16_384) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(sql, out);
  }
  return out;
}

function scan(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const start = i;
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
      out.push({ kind: "comment", text: sql.slice(start, i), start });
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out.push({ kind: "comment", text: sql.slice(start, i), start });
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out.push({ kind: c === "'" ? "string" : "ident", text: sql.slice(start, i), start });
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? n : end + 1;
      out.push({ kind: "ident", text: sql.slice(start, i), start });
    } else if (c === "?") {
      i++;
      while (i < n && /[0-9]/.test(sql[i]!)) i++;
      out.push({ kind: "param", text: sql.slice(start, i), start });
    } else if ((c === ":" || c === "@" || c === "$") && i + 1 < n && WORD.test(sql[i + 1]!)) {
      i++;
      while (i < n && WORD.test(sql[i]!)) i++;
      out.push({ kind: "param", text: sql.slice(start, i), start });
    } else if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i]!)) i++;
      out.push({ kind: "space", text: sql.slice(start, i), start });
    } else if (WORD.test(c)) {
      while (i < n && WORD.test(sql[i]!)) i++;
      out.push({ kind: "word", text: sql.slice(start, i), start });
    } else {
      i++;
      out.push({ kind: "punct", text: c, start });
    }
  }
  return out;
}

const meaningful = (t: SqlToken) => t.kind !== "space" && t.kind !== "comment";

/**
 * Splits a script into statements on top-level semicolons. A CREATE TRIGGER body (BEGIN ... END, with CASE ... END
 * inside it) stays one statement. Statements that hold only whitespace and comments are dropped; each returned
 * statement keeps its own text without the trailing semicolon.
 */
export function splitStatements(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let from = 0;
  let words: string[] = [];
  let depth = 0;
  const flush = (end: number) => {
    const text = sql.slice(from, end);
    if (tokenize(text).some(meaningful)) out.push(text.trim());
  };
  for (const t of tokens) {
    if (t.kind === "word") {
      const w = t.text.toUpperCase();
      if (words.length < 4) words.push(w);
      const trigger = words[0] === "CREATE" && (words[1] === "TRIGGER" || ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
      if (trigger && (w === "BEGIN" || w === "CASE")) depth++;
      else if (trigger && w === "END" && depth > 0) depth--;
    } else if (t.kind === "punct" && t.text === ";" && depth === 0) {
      flush(t.start);
      from = t.start + 1;
      words = [];
    }
  }
  flush(sql.length);
  return out;
}

/** The first `count` keywords of a statement, upper case, skipping comments. */
export function leadingWords(sql: string, count = 3): string[] {
  const out: string[] = [];
  for (const t of tokenize(sql)) {
    if (!meaningful(t)) continue;
    if (t.kind !== "word") break;
    out.push(t.text.toUpperCase());
    if (out.length >= count) break;
  }
  return out;
}

/** Number of distinct bound parameters a statement declares, as sqlite3_bind_parameter_count reports it. */
export function parameterCount(sql: string): number {
  let anon = 0;
  let maxNumbered = 0;
  const named = new Set<string>();
  for (const t of tokenize(sql)) {
    if (t.kind !== "param") continue;
    if (t.text === "?") anon++;
    else if (t.text.startsWith("?")) maxNumbered = Math.max(maxNumbered, Number(t.text.slice(1)));
    else named.add(t.text);
  }
  // SQLite numbers anonymous parameters after the largest explicit number seen so far; Weft and drizzle only use
  // anonymous `?`, so the simple sum is exact for every statement Weft sends.
  return Math.max(anon + named.size, maxNumbered + named.size);
}

/** True when the statement has only anonymous `?` parameters (or none), so positional rewriting is exact. */
export function onlyAnonymousParameters(sql: string): boolean {
  return tokenize(sql).every((t) => t.kind !== "param" || t.text === "?");
}

/**
 * Replaces each anonymous `?` with `literal(args[i])`. The caller checks onlyAnonymousParameters first and that
 * args.length matches the placeholder count.
 */
export function inlineParameters(sql: string, args: readonly unknown[], literal: (v: unknown) => string): string {
  let i = 0;
  return tokenize(sql).map((t) => (t.kind === "param" && t.text === "?" ? literal(args[i++]) : t.text)).join("");
}

export type StatementKind = "read" | "write" | "ddl" | "transaction" | "pragma" | "other";

/** What a statement does, from its leading keywords: enough for metering, never for authorization. */
export function statementKind(sql: string): StatementKind {
  const [a = "", b = ""] = leadingWords(sql, 2);
  if (a === "SELECT" || a === "VALUES" || a === "EXPLAIN") return "read";
  if (a === "WITH") return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ? "write" : "read";
  if (a === "INSERT" || a === "UPDATE" || a === "DELETE" || a === "REPLACE") return "write";
  if (a === "CREATE" || a === "DROP" || a === "ALTER" || a === "REINDEX" || a === "ANALYZE" || a === "VACUUM") return "ddl";
  if (a === "BEGIN" || a === "COMMIT" || a === "END" || a === "ROLLBACK" || a === "SAVEPOINT" || a === "RELEASE") return "transaction";
  if (a === "PRAGMA") return "pragma";
  void b;
  return "other";
}

const unquote = (t: SqlToken | undefined): string | null => {
  if (!t) return null;
  if (t.kind === "ident") return t.text[0] === "[" ? t.text.slice(1, -1) : t.text.slice(1, -1).replace(t.text[0] === "`" ? /``/g : /""/g, t.text[0]!);
  if (t.kind === "word") return t.text;
  return null;
};

/** The table an INSERT, REPLACE, UPDATE or DELETE writes, or the object a CREATE, DROP or ALTER names. */
export function targetTable(sql: string): string | null {
  const tokens = tokenize(sql).filter(meaningful);
  const words = (i: number) => (tokens[i]?.kind === "word" ? tokens[i]!.text.toUpperCase() : "");
  let i = 0;
  if (words(0) === "WITH") {
    // Skip the CTE list: the statement verb is the first INSERT, UPDATE, DELETE or REPLACE at depth 0.
    let depth = 0;
    for (i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind === "punct" && t.text === "(") depth++;
      else if (t.kind === "punct" && t.text === ")") depth--;
      else if (depth === 0 && t.kind === "word" && /^(INSERT|UPDATE|DELETE|REPLACE|SELECT)$/i.test(t.text)) break;
    }
  }
  const verb = words(i);
  let j = i + 1;
  if (verb === "INSERT" || verb === "REPLACE") {
    while (j < tokens.length && words(j) !== "INTO") j++;
    j++;
  } else if (verb === "UPDATE") {
    if (words(j) === "OR") j += 2;
  } else if (verb === "DELETE") {
    if (words(j) === "FROM") j++;
  } else if (verb === "CREATE" || verb === "DROP" || verb === "ALTER") {
    while (j < tokens.length && /^(UNIQUE|TEMP|TEMPORARY|VIRTUAL|TABLE|INDEX|TRIGGER|VIEW|IF|NOT|EXISTS)$/.test(words(j))) j++;
  } else return null;
  // schema-qualified: main."t"
  if (tokens[j + 1]?.kind === "punct" && tokens[j + 1]!.text === ".") j += 2;
  return unquote(tokens[j]);
}

/**
 * The tables a statement reads and writes, for the meter (design 4.2): every identifier that names a known table
 * counts as read, and the statement's target counts as written. Weft's triggers only RAISE and no foreign key
 * cascades, so a statement writes nothing beyond its target.
 */
export function tablesOf(sql: string, known: ReadonlySet<string>): { read: string[]; written: string[] } {
  const kind = statementKind(sql);
  const target = kind === "write" ? targetTable(sql) : null;
  const read = new Set<string>();
  let targetMentions = 0;
  for (const t of tokenize(sql)) {
    if (t.kind !== "word" && t.kind !== "ident") continue;
    const name = unquote(t);
    if (!name || !known.has(name)) continue;
    if (name === target) targetMentions++;
    else read.add(name);
  }
  // INSERT ... SELECT FROM the same table, or an UPDATE whose WHERE reads it again, also reads the target.
  if (target && targetMentions > 1) read.add(target);
  return { read: [...read].sort(), written: target && known.has(target) ? [target] : [] };
}
