'use strict';

/** Same line splitting as VS Code's text model. */
const splitLines = (text) => text.split(/\r\n|\r|\n/);

const detectEol = (text) => {
  const m = /\r\n|\r|\n/.exec(text);
  return m ? m[0] : '\n';
};

const MAX_CELLS = 9e6;

/**
 * Line diff. Returns hunks as half-open line ranges:
 * a[aStart..aEnd) (original) was replaced by b[bStart..bEnd) (new).
 */
function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [{ aStart: s, aEnd: ea, bStart: s, bEnd: eb }];
  }

  // LCS length table over the suffixes.
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] =
        a[s + i] === b[s + j]
          ? t[(i + 1) * w + j + 1] + 1
          : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }

  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      i++;
      j++;
      continue;
    }
    if (!cur) cur = { aStart: s + i, aEnd: s + i, bStart: s + j, bEnd: s + j };
    if (i < n && (j === m || t[(i + 1) * w + j] >= t[i * w + j + 1])) {
      i++;
      cur.aEnd = s + i;
    } else {
      j++;
      cur.bEnd = s + j;
    }
  }
  if (cur) hunks.push(cur);
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

module.exports = { splitLines, detectEol, diffLines, planReplace };
