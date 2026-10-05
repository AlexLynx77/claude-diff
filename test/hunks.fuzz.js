'use strict';
// Randomized test of how a Keep / Undo button finds its change again (no VS Code needed):
// `node test/hunks.fuzz.js`.
// The buttons of a file are drawn once; the user may click several of them before the extension has
// redrawn them, so every click after the first one carries the coordinates of a file that no longer
// exists. Each click must still act on the change it was drawn for, and on nothing else.
const { splitLines, diffLines, planReplace, foldHunk, sigOf, hunkIds, matchHunk } = require('../diff');

let seed = 987654;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (n) => Math.floor(rnd() * n);

let failures = 0;
const fail = (what, data) => {
  if (failures++ < 5) console.error('FAIL', what, JSON.stringify(data));
};

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

/** The text with the old lines of `hunk` put back (what undoHunk does). */
function undoOne(baseline, text, hunk, eol) {
  const original = splitLines(baseline).slice(hunk.aStart, hunk.aEnd);
  return applyPlan(text, planReplace(splitLines(text), hunk.bStart, hunk.bEnd, original, eol));
}

// ---- 1. unique lines: no ambiguity at all, so every click must land on exactly its change
let words = 0;
const fresh = () => `w${words++}`;
const RUNS = 20000;
let clicks = 0;
for (let it = 0; it < RUNS; it++) {
  const eol = ['\n', '\r\n'][ri(2)];
  const a = Array.from({ length: 3 + ri(12) }, fresh);
  if (rnd() < 0.5) a.push(''); // final newline
  const b = [...a];
  for (let k = 0, n = 1 + ri(5); k < n; k++) {
    const at = ri(b.length + 1);
    const t = ri(3);
    if (t === 0) b.splice(at, 0, ...Array.from({ length: 1 + ri(3) }, fresh));
    else if (t === 1) b.splice(at, 1 + ri(2));
    else if (b.length) b[Math.min(at, b.length - 1)] = fresh();
  }
  const baseline = a.join(eol);
  const text = b.join(eol);
  const hunks = diffLines(splitLines(baseline), splitLines(text));
  if (!hunks.length) continue;

  // the buttons, drawn once
  const ids = hunkIds(baseline, text, hunks);
  const buttons = hunks.map((h, i) => ({ sig: sigOf(h), id: ids[i], orig: h, verb: rnd() < 0.5 ? 'keep' : 'undo' }));
  const order = buttons.map((_, i) => i).sort(() => rnd() - 0.5);

  // every click is made on the file as it is NOW (keeps change the baseline, undos change the text)
  let curBase = baseline;
  let curText = text;
  const keptRegions = [];
  const undone = new Set();
  for (const i of order) {
    const bt = buttons[i];
    const cur = diffLines(splitLines(curBase), splitLines(curText));
    const found = matchHunk(cur, hunkIds(curBase, curText, cur), bt.sig, bt.id);
    clicks++;
    if (!found) {
      fail('a button lost its change', { a, b, i, order });
      break;
    }
    if (bt.verb === 'keep') curBase = foldHunk(curBase, curText, found);
    else {
      curText = undoOne(curBase, curText, found, eol);
      undone.add(i);
    }
  }
  // end state: kept changes are in the baseline, undone ones are gone from the text, nothing else moved
  const want = [];
  let ai = 0;
  hunks.forEach((h, i) => {
    want.push(...a.slice(ai, h.aStart));
    want.push(...(undone.has(i) ? a.slice(h.aStart, h.aEnd) : b.slice(h.bStart, h.bEnd)));
    ai = h.aEnd;
  });
  want.push(...a.slice(ai));
  if (splitLines(curText).join('\n') !== want.join('\n')) fail('wrong text', { a, b, order, buttons: buttons.map((x) => x.verb), curText });
  if (diffLines(splitLines(curBase), splitLines(curText)).length) fail('a change is still pending', { a, b, order });
}

// ---- 2. duplicated lines: a click may be ignored, but never lands on a change that says something else
let ignored = 0;
let total = 0;
const POOL = ['}', '', 'a', 'b', 'return x;', '  }', 'foo()'];
for (let it = 0; it < RUNS; it++) {
  const a = Array.from({ length: 1 + ri(12) }, () => POOL[ri(POOL.length)]);
  const b = [...a];
  for (let k = 0, n = 1 + ri(5); k < n; k++) {
    const at = ri(b.length + 1);
    if (rnd() < 0.5) b.splice(at, 0, ...Array.from({ length: 1 + ri(3) }, () => POOL[ri(POOL.length)]));
    else b.splice(at, 1 + ri(2));
  }
  const baseline = a.join('\n');
  const text = b.join('\n');
  const hunks = diffLines(a, b);
  if (!hunks.length) continue;
  const ids = hunkIds(baseline, text, hunks);
  let curBase = baseline;
  for (const i of hunks.map((_, k) => k).sort(() => rnd() - 0.5)) {
    const cur = diffLines(splitLines(curBase), b);
    const curIds = hunkIds(curBase, text, cur);
    const found = matchHunk(cur, curIds, sigOf(hunks[i]), ids[i]);
    total++;
    if (!found) {
      ignored++;
      continue;
    }
    const k = cur.indexOf(found);
    if (curIds[k] !== ids[i]) fail('a click landed on another change', { a, b, i });
    curBase = foldHunk(curBase, text, found);
  }
}
// ignoring is the safe answer, but it must stay the exception
if (ignored / total > 0.05) fail('too many clicks ignored', { ignored, total });

// ---- 3. three identical changes: the stale button of the third one must not act on the second
{
  const base = ['x', 'a', 'x', 'b', 'x', 'c'].join('\n');
  const text = ['x', 'a', 'x', 'NEW', 'b', 'x', 'c', 'NEW'].join('\n');
  const text3 = ['x', 'NEW', 'a', 'x', 'NEW', 'b', 'x', 'NEW', 'c'].join('\n');
  const h = diffLines(splitLines(base), splitLines(text3));
  const idsh = hunkIds(base, text3, h);
  if (h.length !== 3 || new Set(idsh).size !== 1) fail('setup of the identical changes', { h, idsh });
  else {
    const afterFirst = foldHunk(base, text3, h[0]);
    const cur = diffLines(splitLines(afterFirst), splitLines(text3));
    const found = matchHunk(cur, hunkIds(afterFirst, text3, cur), sigOf(h[2]), idsh[2]);
    const third = cur.find((x) => x.bStart === h[2].bStart);
    if (found !== third) fail('identical changes: wrong one found', { found, third, cur });
  }
  void text;
}

// ---- 4. a change that was altered since the button was drawn is not found (never accepted blind)
{
  const base = 'a\nb\nc';
  const before = 'a\nB\nc';
  const after = 'a\nB2\nc';
  const h0 = diffLines(splitLines(base), splitLines(before));
  const id0 = hunkIds(base, before, h0)[0];
  const h1 = diffLines(splitLines(base), splitLines(after));
  if (matchHunk(h1, hunkIds(base, after, h1), sigOf(h0[0]), id0)) fail('an altered change was found', { h0, h1 });
  // without an id (older callers) the signature alone is used
  if (matchHunk(h1, hunkIds(base, after, h1), sigOf(h1[0])) !== h1[0]) fail('signature only', { h1 });
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log(`ok: ${clicks} stale clicks resolved on their own change; ${ignored}/${total} ambiguous ones ignored`);
