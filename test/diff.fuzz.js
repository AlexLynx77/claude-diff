'use strict';
// Randomized test of the diff / keep / undo logic (no VS Code needed): `node test/diff.fuzz.js`.
// For random pairs of texts (LF and CRLF, with or without a final newline) it checks that
//  - the hunks rebuild the new text from the old one,
//  - keeping every hunk one by one (as keepHunk does) ends on the new text,
//  - undoing every hunk one by one (as undoHunk does) ends on the exact original bytes,
//  - the diff is minimal (as many unchanged lines as the longest common subsequence),
// then that a few edits in a very long file stay a few small, quick changes.
const { splitLines, diffLines, planReplace } = require('../diff');

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (n) => Math.floor(rnd() * n);
const WORDS = ['a', 'b', 'c', '{', '}', '', '  x', 'foo()', ')', 'a'];

function gen(eol) {
  const lines = Array.from({ length: ri(9) }, () => WORDS[ri(WORDS.length)]);
  return lines.join(eol) + (rnd() < 0.5 ? eol : '');
}

/** Applies a planReplace() result to a string, like VS Code applies a line/character range edit. */
function applyPlan(text, p) {
  const lines = splitLines(text);
  const seps = text.match(/\r\n|\r|\n/g) || [];
  const starts = [];
  let pos = 0;
  lines.forEach((line, i) => {
    starts.push(pos);
    pos += line.length + (seps[i] ? seps[i].length : 0);
  });
  return text.slice(0, starts[p.sl] + p.sc) + p.text + text.slice(starts[p.el] + p.ec);
}

/** Reference: length of the longest common subsequence (plain dynamic programming). */
function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

let failures = 0;
const fail = (what, data) => {
  if (failures++ < 5) console.error('FAIL', what, JSON.stringify(data));
};

/** Hunks are ordered, aligned, rebuild b from a, and keep as many lines as the LCS. */
function checkHunks(label, a, b, hunks) {
  const rebuilt = [];
  let ai = 0;
  let aligned = true;
  for (const h of hunks) {
    if (h.aStart < ai || h.aEnd < h.aStart || h.bEnd < h.bStart) aligned = false;
    rebuilt.push(...a.slice(ai, h.aStart));
    if (rebuilt.length !== h.bStart) aligned = false;
    rebuilt.push(...b.slice(h.bStart, h.bEnd));
    ai = h.aEnd;
  }
  rebuilt.push(...a.slice(ai));
  if (!aligned || rebuilt.join('\n') !== b.join('\n')) fail(label + 'rebuild', { a, b, hunks });
  const kept = a.length - hunks.reduce((n, h) => n + h.aEnd - h.aStart, 0);
  if (kept !== lcs(a, b)) fail(label + 'minimal', { a, b, hunks, kept, lcs: lcs(a, b) });
}

const RUNS = 50000;
for (let it = 0; it < RUNS; it++) {
  const eol = ['\n', '\r\n'][ri(2)];
  const A = gen(eol);
  const B = gen(eol);
  const a = splitLines(A);
  const b = splitLines(B);
  // 1. hunks are ordered, aligned, rebuild b from a and are minimal (LCS table, and Myers alone)
  checkHunks('', a, b, diffLines(a, b));
  checkHunks('Myers: ', a, b, diffLines(a, b, 0));

  // 2. keep hunks one by one
  const base = a.slice();
  let hs = diffLines(base, b);
  for (let guard = 0; hs.length && guard < 50; guard++) {
    const h = hs[ri(hs.length)];
    base.splice(h.aStart, h.aEnd - h.aStart, ...b.slice(h.bStart, h.bEnd));
    hs = diffLines(base, b);
  }
  if (base.join('\n') !== b.join('\n')) fail('keep one by one', { A, B });

  // 3. undo hunks one by one, in random order
  let doc = B;
  hs = diffLines(a, splitLines(doc));
  for (let guard = 0; hs.length && guard < 50; guard++) {
    const h = hs[ri(hs.length)];
    const plan = planReplace(splitLines(doc), h.bStart, h.bEnd, a.slice(h.aStart, h.aEnd), eol);
    doc = applyPlan(doc, plan);
    hs = diffLines(a, splitLines(doc));
  }
  if (doc !== A) fail('undo one by one', { A, B, doc });
}

// Bigger texts, few distinct lines (many ways to align them): still exact and minimal.
const BIG = 3000;
for (let it = 0; it < BIG; it++) {
  const n = 20 + ri(120);
  const a = Array.from({ length: n }, () => WORDS[ri(4)]);
  const b = a.slice();
  for (let k = 0, edits = 1 + ri(12); k < edits; k++) {
    const at = ri(b.length + 1);
    if (rnd() < 0.5) b.splice(at, ri(4), ...Array.from({ length: ri(4) }, () => WORDS[ri(WORDS.length)]));
    else b.splice(at, 1 + ri(3));
  }
  checkHunks('big: ', a, b, diffLines(a, b));
  checkHunks('big, Myers: ', a, b, diffLines(a, b, 0));
}

// A 60 000-line file with two edits far apart: two small changes, found fast.
{
  const a = Array.from({ length: 60000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[10] = 'changed near the top';
  b.splice(59990, 1, 'changed', 'near the bottom');
  const t0 = Date.now();
  const hunks = diffLines(a, b);
  const ms = Date.now() - t0;
  if (hunks.length !== 2 || hunks[0].aStart !== 10 || hunks[1].aStart !== 59990) fail('long file: two changes', hunks);
  if (ms > 500) fail('long file: fast', { ms });
  // Completely rewritten: one change, without hanging.
  const t1 = Date.now();
  const all = diffLines(a, a.map((l) => l + '!'));
  if (all.length !== 1 || Date.now() - t1 > 3000) fail('rewritten file', { hunks: all.length, ms: Date.now() - t1 });
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`diff fuzz: ${RUNS + BIG} random cases and the long-file cases passed`);
