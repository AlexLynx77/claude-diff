'use strict';
// Randomized test of the diff / keep / undo logic (no VS Code needed): `node test/diff.fuzz.js`.
// For random pairs of texts (LF and CRLF, with or without a final newline) it checks that
//  - the hunks rebuild the new text from the old one,
//  - keeping every hunk one by one (as keepHunk does) ends on the new text,
//  - undoing every hunk one by one (as undoHunk does) ends on the exact original bytes.
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

let failures = 0;
const fail = (what, data) => {
  if (failures++ < 5) console.error('FAIL', what, JSON.stringify(data));
};

const RUNS = 50000;
for (let it = 0; it < RUNS; it++) {
  const eol = ['\n', '\r\n'][ri(2)];
  const A = gen(eol);
  const B = gen(eol);
  const a = splitLines(A);
  const b = splitLines(B);
  const hunks = diffLines(a, b);

  // 1. hunks are ordered, aligned, and rebuild b from a
  const rebuilt = [];
  let ai = 0;
  let aligned = true;
  for (const h of hunks) {
    if (h.aStart < ai) aligned = false;
    rebuilt.push(...a.slice(ai, h.aStart));
    if (rebuilt.length !== h.bStart) aligned = false;
    rebuilt.push(...b.slice(h.bStart, h.bEnd));
    ai = h.aEnd;
  }
  rebuilt.push(...a.slice(ai));
  if (!aligned || rebuilt.join('\n') !== b.join('\n')) fail('rebuild', { A, B, hunks });

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

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`diff fuzz: ${RUNS} random cases passed`);
