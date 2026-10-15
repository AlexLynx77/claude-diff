'use strict';
const crypto = require('crypto');

/** Same line splitting as VS Code's text model. */
const splitLines = (text) => text.split(/\r\n|\r|\n/);

const detectEol = (text) => {
  const m = /\r\n|\r|\n/.exec(text);
  return m ? m[0] : '\n';
};

/** Work allowed to one middle-snake search; past it, that region is shown as a single change. */
const MAX_COST = 2e7;

/**
 * Myers' middle snake (O((N+M)·D) time, O(N+M) memory) between A[aLo..aHi) and B[bLo..bHi), which
 * share neither their first nor their last line. Returns a split point [x, y] such that diffing
 * both halves separately is still minimal, or null when nothing matches (or it would cost too much).
 */
function bisect(A, aLo, aHi, B, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0; // the paths meet while going forward (else backward)
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  let cost = 0;
  for (let d = 0; d < maxD; d++) {
    if (cost > MAX_COST) return null;
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1;
      let y1 = x1 - k1;
      const from1 = x1;
      while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
        x1++;
        y1++;
      }
      cost += 1 + x1 - from1;
      v1[i1] = x1;
      if (x1 > n) k1end += 2; // off the right edge
      else if (y1 > m) k1start += 2; // off the bottom
      else if (front) {
        const i2 = off + delta - k1;
        if (i2 >= 0 && i2 < len && v2[i2] !== -1 && x1 >= n - v2[i2]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1;
      let y2 = x2 - k2;
      const from2 = x2;
      while (x2 < n && y2 < m && A[aHi - 1 - x2] === B[bHi - 1 - y2]) {
        x2++;
        y2++;
      }
      cost += 1 + x2 - from2;
      v2[i2] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const i1 = off + delta - k2;
        if (i1 >= 0 && i1 < len && v1[i1] !== -1) {
          const x1 = v1[i1];
          const y1 = off + x1 - i1;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

/** Regions up to this many cells use the LCS table: its alignment of repeated lines is the most stable. */
const MAX_CELLS = 4e6;

/**
 * LCS table over A[aLo..aHi) × B[bLo..bHi), walked from the top taking every match it can
 * (old lines before new ones on ties). Calls same(i, j, 1) for each matched line, in order.
 */
function table(A, aLo, aHi, B, bLo, bHi, same) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = A[aLo + i] === B[bLo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[aLo + i] === B[bLo + j]) {
      same(aLo + i, bLo + j, 1);
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
}

/** Calls same(i, j, count) for every run of equal lines A[i..) = B[j..), in order. */
function walk(A, aLo, aHi, B, bLo, bHi, same, maxCells) {
  let p = 0;
  while (aLo + p < aHi && bLo + p < bHi && A[aLo + p] === B[bLo + p]) p++;
  same(aLo, bLo, p);
  aLo += p;
  bLo += p;
  let s = 0;
  while (aHi - s > aLo && bHi - s > bLo && A[aHi - 1 - s] === B[bHi - 1 - s]) s++;
  aHi -= s;
  bHi -= s;
  if (aLo < aHi && bLo < bHi && (aHi - aLo) * (bHi - bLo) <= maxCells) {
    table(A, aLo, aHi, B, bLo, bHi, same);
  } else if (aLo < aHi && bLo < bHi) {
    const mid = bisect(A, aLo, aHi, B, bLo, bHi);
    const splits = mid && !(mid[0] === aLo && mid[1] === bLo) && !(mid[0] === aHi && mid[1] === bHi);
    if (splits) {
      walk(A, aLo, mid[0], B, bLo, mid[1], same, maxCells);
      walk(A, mid[0], aHi, B, mid[1], bHi, same, maxCells);
    }
  }
  same(aHi, bHi, s);
}

/** Lines as small integers (equal lines, equal numbers): comparisons no longer read the text. */
function intern(lines, ids) {
  const out = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    let id = ids.get(lines[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(lines[i], id);
    }
    out[i] = id;
  }
  return out;
}

/**
 * Line diff (minimal, Myers). Returns hunks as half-open line ranges:
 * a[aStart..aEnd) (original) was replaced by b[bStart..bEnd) (new).
 * Its cost grows with the size of the changes, not of the file: a few edits in a long file stay
 * separate changes. `maxCells` is for tests (0: Myers only).
 */
function diffLines(a, b, maxCells = MAX_CELLS) {
  const ids = new Map();
  const A = intern(a, ids);
  const B = intern(b, ids);
  const hunks = [];
  let ai = 0;
  let bi = 0;
  walk(A, 0, A.length, B, 0, B.length, (i, j, count) => {
    if (!count) return;
    if (i > ai || j > bi) hunks.push({ aStart: ai, aEnd: i, bStart: bi, bEnd: j });
    ai = i + count;
    bi = j + count;
  }, maxCells);
  if (ai < A.length || bi < B.length) hunks.push({ aStart: ai, aEnd: A.length, bStart: bi, bEnd: B.length });
  return hunks;
}

/**
 * Plan a text edit that replaces the lines [i, j) of a document (given as its
 * array of lines) with `repl`. Returns a range (line/character) plus new text.
 */
function planReplace(lines, i, j, repl, eol) {
  const n = lines.length;
  if (j < n) {
    return { sl: i, sc: 0, el: j, ec: 0, text: repl.map((x) => x + eol).join('') };
  }
  if (i > 0) {
    return {
      sl: i - 1,
      sc: lines[i - 1].length,
      el: n - 1,
      ec: lines[n - 1].length,
      text: repl.map((x) => eol + x).join(''),
    };
  }
  return { sl: 0, sc: 0, el: n - 1, ec: lines[n - 1].length, text: repl.join(eol) };
}

/** The "before" text once `hunk` is accepted: its new lines replace the old ones in the baseline. */
function foldHunk(baseline, text, hunk) {
  const base = splitLines(baseline);
  base.splice(hunk.aStart, hunk.aEnd - hunk.aStart, ...splitLines(text).slice(hunk.bStart, hunk.bEnd));
  return base.join(detectEol(baseline));
}

const sigOf = (h) => `${h.aStart}:${h.aEnd}:${h.bStart}:${h.bEnd}`;

/**
 * Identity of each hunk by what it changes (its old and new lines), not by where it is: accepting or
 * undoing another change moves every later hunk, but never alters what it says.
 */
function hunkIds(baseline, text, hunks) {
  const a = baseline === null ? [] : splitLines(baseline);
  const b = splitLines(text);
  return hunks.map((h) =>
    crypto.createHash('md5').update(JSON.stringify([a.slice(h.aStart, h.aEnd), b.slice(h.bStart, h.bEnd)])).digest('hex').slice(0, 12)
  );
}

/**
 * Finds again, among the current `hunks` (with their `ids`), the change a Keep / Undo button was
 * drawn for, given the signature and id it was drawn with. The buttons can be a little older than
 * the file (clicked right after another change was kept or undone): the coordinates may have moved,
 * what the change says has not. Returns undefined when that change is gone or was altered.
 */
function matchHunk(hunks, ids, sig, id) {
  if (!id) return hunks.find((h) => sigOf(h) === sig);
  const same = hunks.filter((_, i) => ids[i] === id);
  const exact = same.find((h) => sigOf(h) === sig);
  if (exact || same.length <= 1) return exact || same[0];
  // several identical changes: the one that is closest to where it was
  const [aStart, , bStart] = sig.split(':').map(Number);
  const gap = (h) => Math.min(Math.abs(h.aStart - aStart), Math.abs(h.bStart - bStart));
  return same.reduce((best, h) => (gap(h) < gap(best) ? h : best));
}

module.exports = { splitLines, detectEol, diffLines, planReplace, foldHunk, sigOf, hunkIds, matchHunk };
