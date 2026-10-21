// A port of git's xdiff (xdiff/xprepare.c, xdiffi.c and xemit.c) for the unified diffs `git log -p` prints, so the
// SQL memory repo's history output matches the git CLI byte for byte: Myers bisection with git's heuristics, the
// discarding of lines with no match, group compaction with the indent heuristic (on by default since git 2.14), three
// lines of context, hunks merged when at most six lines apart, and the default function-name line after "@@" (the
// nearest earlier old-side line that starts with a letter, "_" or "$", at most 80 bytes). Inputs and output are bytes,
// as git's are.
import { concat, utf8 } from "./gitobj";

const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;
const XDL_KPDIS_RUN = 4;
const XDL_LINE_MAX = Number.MAX_SAFE_INTEGER;
const CONTEXT = 3;
const FUNC_BUF = 80;
const HUNK_HDR_BUF = 128;

interface XFile {
  recs: Uint8Array[];
  ha: number[];
  nrec: number;
  /** rchg[i + 1] marks record i changed; rchg[0] and rchg[nrec + 1] stay 0 (git's rchg[-1] and rchg[nrec]). */
  rchg: Uint8Array;
  rindex: number[];
  rha: number[];
  nreff: number;
  dstart: number;
  dend: number;
}

/** Splits into records the way xdiff does: each line keeps its "\n"; a last line without one is still a record. */
export function splitRecords(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { out.push(buf.subarray(start, i + 1)); start = i + 1; }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

const key = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096)); return s; };

function bogosqrt(n: number): number {
  let i = 1;
  for (; n > 0; n = Math.floor(n / 4)) i <<= 1;
  return i;
}

function prepare(a: Uint8Array, b: Uint8Array): { x1: XFile; x2: XFile } {
  const classes = new Map<string, number>();
  const len1: number[] = [];
  const len2: number[] = [];
  const mk = (buf: Uint8Array, pass: 1 | 2): XFile => {
    const recs = splitRecords(buf);
    const ha = recs.map((r) => {
      const k = key(r);
      let c = classes.get(k);
      if (c === undefined) { c = classes.size; classes.set(k, c); len1.push(0); len2.push(0); }
      if (pass === 1) len1[c]!++; else len2[c]!++;
      return c;
    });
    return { recs, ha, nrec: recs.length, rchg: new Uint8Array(recs.length + 2), rindex: [], rha: [], nreff: 0, dstart: 0, dend: -1 };
  };
  const x1 = mk(a, 1);
  const x2 = mk(b, 2);
  // xdl_trim_ends
  let i = 0;
  let lim = Math.min(x1.nrec, x2.nrec);
  for (; i < lim; i++) if (x1.ha[i] !== x2.ha[i]) break;
  x1.dstart = x2.dstart = i;
  lim -= i;
  let j = 0;
  for (; j < lim; j++) if (x1.ha[x1.nrec - 1 - j] !== x2.ha[x2.nrec - 1 - j]) break;
  x1.dend = x1.nrec - j - 1;
  x2.dend = x2.nrec - j - 1;
  // xdl_cleanup_records
  const dis = (x: XFile, other: number[]) => {
    const d = new Uint8Array(x.nrec + 1);
    const mlim = Math.min(bogosqrt(x.nrec), XDL_MAX_EQLIMIT);
    for (let k = x.dstart; k <= x.dend; k++) {
      const nm = other[x.ha[k]!] ?? 0;
      d[k] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
    }
    return d;
  };
  const dis1 = dis(x1, len2);
  const dis2 = dis(x2, len1);
  const reduce = (x: XFile, d: Uint8Array) => {
    for (let k = x.dstart; k <= x.dend; k++) {
      if (d[k] === 1 || (d[k] === 2 && !cleanMmatch(d, k, x.dstart, x.dend))) {
        x.rindex.push(k);
        x.rha.push(x.ha[k]!);
      } else x.rchg[k + 1] = 1;
    }
    x.nreff = x.rindex.length;
  };
  reduce(x1, dis1);
  reduce(x2, dis2);
  return { x1, x2 };
}

function cleanMmatch(dis: Uint8Array, i: number, s: number, e: number): boolean {
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW;
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW;
  let r: number;
  let rdis0 = 0;
  let rpdis0 = 1;
  for (r = 1; i - r >= s; r++) {
    if (!dis[i - r]) rdis0++;
    else if (dis[i - r] === 2) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (r = 1; i + r <= e; r++) {
    if (!dis[i + r]) rdis1++;
    else if (dis[i + r] === 2) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;
  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1;
}

interface Split { i1: number; i2: number; minLo: boolean; minHi: boolean }
interface Env { mxcost: number; snakeCnt: number; heurMin: number }

/** Signed-index arrays for the diagonals (git offsets its C arrays the same way). */
class Diag {
  private readonly v: number[];
  constructor(size: number, private readonly off: number) { this.v = new Array<number>(size).fill(0); }
  get(d: number) { return this.v[d + this.off]!; }
  set(d: number, x: number) { this.v[d + this.off] = x; }
}

function split(ha1: number[], off1: number, lim1: number, ha2: number[], off2: number, lim2: number, kvdf: Diag, kvdb: Diag, needMin: boolean, env: Env): Split {
  const dmin = off1 - lim2, dmax = lim1 - off2;
  const fmid = off1 - off2, bmid = lim1 - lim2;
  const odd = ((fmid - bmid) & 1) !== 0;
  let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
  kvdf.set(fmid, off1);
  kvdb.set(bmid, lim1);
  for (let ec = 1; ; ec++) {
    let gotSnake = false;
    if (fmin > dmin) kvdf.set(--fmin - 1, -1); else ++fmin;
    if (fmax < dmax) kvdf.set(++fmax + 1, -1); else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvdf.get(d - 1) >= kvdf.get(d + 1) ? kvdf.get(d - 1) + 1 : kvdf.get(d + 1);
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]; i1++, i2++);
      if (i1 - prev1 > env.snakeCnt) gotSnake = true;
      kvdf.set(d, i1);
      if (odd && bmin <= d && d <= bmax && kvdb.get(d) <= i1) return { i1, i2, minLo: true, minHi: true };
    }
    if (bmin > dmin) kvdb.set(--bmin - 1, XDL_LINE_MAX); else ++bmin;
    if (bmax < dmax) kvdb.set(++bmax + 1, XDL_LINE_MAX); else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvdb.get(d - 1) < kvdb.get(d + 1) ? kvdb.get(d - 1) : kvdb.get(d + 1) - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]; i1--, i2--);
      if (prev1 - i1 > env.snakeCnt) gotSnake = true;
      kvdb.set(d, i1);
      if (!odd && fmin <= d && d <= fmax && i1 <= kvdf.get(d)) return { i1, i2, minLo: true, minHi: true };
    }
    if (needMin) continue;
    if (gotSnake && ec > env.heurMin) {
      let best = 0;
      let spl: Split | null = null;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = kvdf.get(d);
        const i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (v > XDL_K_HEUR * ec && v > best && off1 + env.snakeCnt <= i1 && i1 < lim1 && off2 + env.snakeCnt <= i2 && i2 < lim2) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) {
            if (k === env.snakeCnt) { best = v; spl = { i1, i2, minLo: true, minHi: false }; break; }
          }
        }
      }
      if (best > 0 && spl) return spl;
      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = kvdb.get(d);
        const i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (v > XDL_K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - env.snakeCnt && off2 < i2 && i2 <= lim2 - env.snakeCnt) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) {
            if (k === env.snakeCnt - 1) { best = v; spl = { i1, i2, minLo: false, minHi: true }; break; }
          }
        }
      }
      if (best > 0 && spl) return spl;
    }
    if (ec >= env.mxcost) {
      let fbest = -1, fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvdf.get(d), lim1);
        let i2 = i1 - d;
        if (lim2 < i2) { i1 = lim2 + d; i2 = lim2; }
        if (fbest < i1 + i2) { fbest = i1 + i2; fbest1 = i1; }
      }
      let bbest = XDL_LINE_MAX, bbest1 = XDL_LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvdb.get(d));
        let i2 = i1 - d;
        if (i2 < off2) { i1 = off2 + d; i2 = off2; }
        if (i1 + i2 < bbest) { bbest = i1 + i2; bbest1 = i1; }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false };
      return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
    }
  }
}

function recsCmp(x1: XFile, off1: number, lim1: number, x2: XFile, off2: number, lim2: number, kvdf: Diag, kvdb: Diag, needMin: boolean, env: Env): void {
  const ha1 = x1.rha, ha2 = x2.rha;
  for (; off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]; off1++, off2++);
  for (; off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]; lim1--, lim2--);
  if (off1 === lim1) {
    for (; off2 < lim2; off2++) x2.rchg[x2.rindex[off2]! + 1] = 1;
  } else if (off2 === lim2) {
    for (; off1 < lim1; off1++) x1.rchg[x1.rindex[off1]! + 1] = 1;
  } else {
    const spl = split(ha1, off1, lim1, ha2, off2, lim2, kvdf, kvdb, needMin, env);
    recsCmp(x1, off1, spl.i1, x2, off2, spl.i2, kvdf, kvdb, spl.minLo, env);
    recsCmp(x1, spl.i1, lim1, x2, spl.i2, lim2, kvdf, kvdb, spl.minHi, env);
  }
}

// ---- compaction and the indent heuristic (xdiffi.c) -----------------------------------------------------------

const ch = (x: XFile, i: number) => x.rchg[i + 1]!;
const setCh = (x: XFile, i: number, v: number) => { x.rchg[i + 1] = v; };
interface Group { start: number; end: number }

function groupInit(x: XFile): Group { const g = { start: 0, end: 0 }; while (ch(x, g.end)) g.end++; return g; }
function groupNext(x: XFile, g: Group): boolean {
  if (g.end === x.nrec) return false;
  g.start = g.end + 1;
  for (g.end = g.start; ch(x, g.end); g.end++);
  return true;
}
function groupPrevious(x: XFile, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; ch(x, g.start - 1); g.start--);
  return true;
}
function groupSlideDown(x: XFile, g: Group): boolean {
  if (g.end < x.nrec && x.ha[g.start] === x.ha[g.end]) {
    setCh(x, g.start++, 0);
    setCh(x, g.end++, 1);
    while (ch(x, g.end)) g.end++;
    return true;
  }
  return false;
}
function groupSlideUp(x: XFile, g: Group): boolean {
  if (g.start > 0 && x.ha[g.start - 1] === x.ha[g.end - 1]) {
    setCh(x, --g.start, 1);
    setCh(x, --g.end, 0);
    while (ch(x, g.start - 1)) g.start--;
    return true;
  }
  return false;
}

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const INDENT_HEURISTIC_MAX_SLIDING = 100;
const P = { startOfFile: 1, endOfFile: 21, totalBlank: -30, postBlank: 6, relIndent: -4, relIndentBlank: 10, relOutdent: 24, relOutdentBlank: 17, relDedent: 23, relDedentBlank: 17, indentWeight: 60 } as const;

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
function getIndent(rec: Uint8Array): number {
  let ret = 0;
  for (let i = 0; i < rec.length; i++) {
    const c = rec[i]!;
    if (!isSpace(c)) return ret;
    if (c === 0x20) ret += 1;
    else if (c === 0x09) ret += 8 - (ret % 8);
    if (ret >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

interface Measure { endOfFile: boolean; indent: number; preBlank: number; preIndent: number; postBlank: number; postIndent: number }
function measureSplit(x: XFile, splitAt: number): Measure {
  const m: Measure = { endOfFile: false, indent: -1, preBlank: 0, preIndent: -1, postBlank: 0, postIndent: -1 };
  if (splitAt >= x.nrec) { m.endOfFile = true; m.indent = -1; } else m.indent = getIndent(x.recs[splitAt]!);
  for (let i = splitAt - 1; i >= 0; i--) {
    m.preIndent = getIndent(x.recs[i]!);
    if (m.preIndent !== -1) break;
    m.preBlank += 1;
    if (m.preBlank === MAX_BLANKS) { m.preIndent = 0; break; }
  }
  for (let i = splitAt + 1; i < x.nrec; i++) {
    m.postIndent = getIndent(x.recs[i]!);
    if (m.postIndent !== -1) break;
    m.postBlank += 1;
    if (m.postBlank === MAX_BLANKS) { m.postIndent = 0; break; }
  }
  return m;
}
interface Score { effectiveIndent: number; penalty: number }
function scoreAddSplit(m: Measure, s: Score): void {
  if (m.preIndent === -1 && m.preBlank === 0) s.penalty += P.startOfFile;
  if (m.endOfFile) s.penalty += P.endOfFile;
  const postBlank = m.indent === -1 ? 1 + m.postBlank : 0;
  const totalBlank = m.preBlank + postBlank;
  s.penalty += P.totalBlank * totalBlank;
  s.penalty += P.postBlank * postBlank;
  const indent = m.indent !== -1 ? m.indent : m.postIndent;
  const anyBlanks = totalBlank !== 0;
  s.effectiveIndent += indent;
  if (indent === -1 || m.preIndent === -1) { /* no adjustment */ }
  else if (indent > m.preIndent) s.penalty += anyBlanks ? P.relIndentBlank : P.relIndent;
  else if (indent === m.preIndent) { /* same level */ }
  else if (m.postIndent !== -1 && m.postIndent > indent) s.penalty += anyBlanks ? P.relOutdentBlank : P.relOutdent;
  else s.penalty += anyBlanks ? P.relDedentBlank : P.relDedent;
}
const scoreCmp = (a: Score, b: Score) => P.indentWeight * (Number(a.effectiveIndent > b.effectiveIndent) - Number(a.effectiveIndent < b.effectiveIndent)) + (a.penalty - b.penalty);

function changeCompact(x: XFile, xo: XFile): void {
  const g = groupInit(x);
  const go = groupInit(xo);
  for (;;) {
    if (g.end !== g.start) {
      let groupsize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;
        while (groupSlideUp(x, g)) if (!groupPrevious(xo, go)) throw new Error("xdiff: group sync broken sliding up");
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!groupSlideDown(x, g)) break;
          if (!groupNext(xo, go)) throw new Error("xdiff: group sync broken sliding down");
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== g.end - g.start);
      if (g.end === earliestEnd) {
        /* no shifting was possible */
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(x, g)) throw new Error("xdiff: match disappeared");
          if (!groupPrevious(xo, go)) throw new Error("xdiff: group sync broken sliding to match");
        }
      } else {
        let shift = earliestEnd;
        if (g.end - groupsize - 1 > shift) shift = g.end - groupsize - 1;
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) shift = g.end - INDENT_HEURISTIC_MAX_SLIDING;
        let bestShift = -1;
        let best: Score = { effectiveIndent: 0, penalty: 0 };
        for (; shift <= g.end; shift++) {
          const score: Score = { effectiveIndent: 0, penalty: 0 };
          scoreAddSplit(measureSplit(x, shift), score);
          scoreAddSplit(measureSplit(x, shift - groupsize), score);
          if (bestShift === -1 || scoreCmp(score, best) <= 0) { best = { ...score }; bestShift = shift; }
        }
        while (g.end > bestShift) {
          if (!groupSlideUp(x, g)) throw new Error("xdiff: best shift unreached");
          if (!groupPrevious(xo, go)) throw new Error("xdiff: group sync broken sliding to blank line");
        }
      }
    }
    if (!groupNext(x, g)) break;
    if (!groupNext(xo, go)) throw new Error("xdiff: group sync broken moving to next group");
  }
  if (groupNext(xo, go)) throw new Error("xdiff: group sync broken at end of file");
}

// ---- script and emission (xemit.c) ----------------------------------------------------------------------------

interface Change { i1: number; i2: number; chg1: number; chg2: number }

function buildScript(x1: XFile, x2: XFile): Change[] {
  const out: Change[] = [];
  for (let i1 = x1.nrec, i2 = x2.nrec; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (ch(x1, i1 - 1) || ch(x2, i2 - 1)) {
      const l1 = i1, l2 = i2;
      for (; ch(x1, i1 - 1); i1--);
      for (; ch(x2, i2 - 1); i2--);
      out.unshift({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return out;
}

const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** git's def_ff: a line starting with a letter, "_" or "$", cut to 80 bytes, trailing whitespace removed. */
function defaultFuncLine(rec: Uint8Array): Uint8Array | null {
  if (rec.length === 0) return null;
  const c = rec[0]!;
  if (!(isAlpha(c) || c === 0x5f || c === 0x24)) return null;
  let len = Math.min(rec.length, FUNC_BUF);
  while (len > 0 && isSpace(rec[len - 1]!)) len--;
  return rec.subarray(0, len);
}

const NO_NEWLINE = utf8("\n\\ No newline at end of file\n");

/**
 * The hunks of a unified diff between two byte strings, exactly as git prints them after the file header (an empty
 * array when they are equal).
 */
export function unifiedHunks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const { x1, x2 } = prepare(a, b);
  const ndiags = x1.nreff + x2.nreff + 3;
  const kvdf = new Diag(ndiags + 2, x2.nreff + 2);
  const kvdb = new Diag(ndiags + 2, x2.nreff + 2);
  const env: Env = { mxcost: Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN), snakeCnt: XDL_SNAKE_CNT, heurMin: XDL_HEUR_MIN_COST };
  recsCmp(x1, 0, x1.nreff, x2, 0, x2.nreff, kvdf, kvdb, false, env);
  changeCompact(x1, x2);
  changeCompact(x2, x1);
  const script = buildScript(x1, x2);
  const out: Uint8Array[] = [];
  const emit = (rec: Uint8Array, pre: string) => {
    out.push(utf8(pre), rec);
    if (rec.length === 0 || rec[rec.length - 1] !== 0x0a) out.push(NO_NEWLINE);
  };
  let funcLine: Uint8Array = new Uint8Array(0);
  let funclinePrev = -1;
  const maxCommon = 2 * CONTEXT;
  let idx = 0;
  while (idx < script.length) {
    // xdl_get_hunk: extend while the next change starts at most 2 * context lines after this one ends.
    let last = idx;
    while (last + 1 < script.length && script[last + 1]!.i1 - (script[last]!.i1 + script[last]!.chg1) <= maxCommon) last++;
    const first = script[idx]!;
    const xche = script[last]!;
    let s1 = Math.max(first.i1 - CONTEXT, 0);
    let s2 = Math.max(first.i2 - CONTEXT, 0);
    let lctx = CONTEXT;
    lctx = Math.min(lctx, x1.nrec - (xche.i1 + xche.chg1));
    lctx = Math.min(lctx, x2.nrec - (xche.i2 + xche.chg2));
    const e1 = xche.i1 + xche.chg1 + lctx;
    const e2 = xche.i2 + xche.chg2 + lctx;
    // get_func_line from s1 - 1 back to (not including) the previous hunk's start; the last one found stays.
    const start = s1 - 1;
    const step = start > funclinePrev ? -1 : 1;
    for (let l = start; l !== funclinePrev && l >= 0 && l < x1.nrec; l += step) {
      const f = defaultFuncLine(x1.recs[l]!);
      if (f) { funcLine = f; break; }
    }
    funclinePrev = s1 - 1;
    const c1 = e1 - s1, c2 = e2 - s2;
    let head = `@@ -${c1 ? s1 + 1 : s1}${c1 !== 1 ? `,${c1}` : ""} +${c2 ? s2 + 1 : s2}${c2 !== 1 ? `,${c2}` : ""} @@`;
    const headBytes: Uint8Array[] = [utf8(head)];
    if (funcLine.length) {
      const room = HUNK_HDR_BUF - utf8(head).length - 1 - 1;
      headBytes.push(utf8(" "), funcLine.subarray(0, Math.max(0, Math.min(funcLine.length, room))));
    }
    headBytes.push(utf8("\n"));
    out.push(...headBytes);
    head = "";
    for (; s2 < first.i2; s2++) emit(x2.recs[s2]!, " ");
    for (let k = idx; ; k++) {
      const c = script[k]!;
      for (s1 = k === idx ? first.i1 : s1, s2 = k === idx ? first.i2 : s2; s1 < c.i1 && s2 < c.i2; s1++, s2++) emit(x2.recs[s2]!, " ");
      for (s1 = c.i1; s1 < c.i1 + c.chg1; s1++) emit(x1.recs[s1]!, "-");
      for (s2 = c.i2; s2 < c.i2 + c.chg2; s2++) emit(x2.recs[s2]!, "+");
      if (k === last) break;
      s1 = c.i1 + c.chg1;
      s2 = c.i2 + c.chg2;
    }
    for (s2 = xche.i2 + xche.chg2; s2 < e2; s2++) emit(x2.recs[s2]!, " ");
    idx = last + 1;
  }
  return concat(out);
}
