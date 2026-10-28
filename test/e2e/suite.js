'use strict';
// Runs INSIDE the VS Code extension host (started by test/e2e/run.js).
// A fake Claude Code transcript makes the extension believe Claude is working, then the
// test edits files on disk the way Claude would and drives the extension's commands.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const { hunkIds } = require('../../diff');
const pkg = require('../../package.json');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, step = 200) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - start > ms) return v;
    await sleep(step);
  }
};
const sigOf = (h) => `${h.aStart}:${h.aEnd}:${h.bStart}:${h.bEnd}`;
const compiles = (src) => {
  try {
    new vm.Script(src);
    return true;
  } catch {
    return false;
  }
};

/** r.txt as Claude leaves it after round k: three spots change each time (+1 line, -1 line, same size). */
const round = (k) =>
  [
    'c1',
    ...(k % 2 ? ['x' + k, 'y' + k] : ['x' + k]),
    'c3',
    'c4',
    ...(k % 2 ? [] : ['z' + k]),
    'c5',
    'c6',
    'c7',
    'q' + k,
    'c9',
  ].join('\n') + '\n';
const text = (...lines) => lines.join('\n') + '\n';

const ORIGINAL = {
  'a.json': '{\n  "name": "x",\n  "version": 1,\n  "list": [1, 2, 3]\n}\n',
  'b.js': 'function add(a, b) {\n  const s = a + b;\n  return s;\n}\nmodule.exports = { add };\n',
  'c.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n',
  'd.css': 'body {\n  color: red;\n}\n.a {\n  margin: 0;\n}\n',
  'e.crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  'f.bom.js': '\ufeffconst a = 1;\nconst b = 2;\n',
  'g.txt': 'keep me\nstay\n',
  'r.txt': round(0),
  'r2.txt': text('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'),
  'r3.txt': text('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'),
  'r4.txt': text('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'),
  'k.txt': text('k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12'),
};

async function main() {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  const api = await ext.activate();
  await until(() => api._ready());
  check('extension activates and the tracker is ready', api._ready(), 'tracker never became ready');

  const put = (f, s) => fs.writeFileSync(path.join(ws, f), s);
  const read = (f) => fs.readFileSync(path.join(ws, f), 'utf8');
  const entry = (f) => api._entries().find((e) => path.basename(e.file) === f);
  for (const [f, s] of Object.entries(ORIGINAL)) put(f, s);
  await sleep(2500);

  // Claude Code is "working" as long as a transcript of this folder is being written.
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, 'session.jsonl');
  const beat = () => fs.appendFileSync(transcript, '{"t":1}\n');
  beat();
  await sleep(8000); // the extension notices activity, then absorbs the current state
  beat();

  // ---- what Claude does
  put('a.json', '{\n  "name": "y",\n  "version": 2,\n  "list": [1, 2, 3, 4],\n  "extra": true\n}\n');
  put('b.js', 'function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\nmodule.exports = { add, sub };\n');
  put('c.py', 'def f(x):\n    if x is None:\n        return 0\n    return 2\n');
  put('d.css', 'body {\n  color: blue;\n}\n.b {\n  margin: 1px;\n}\n');
  put('e.crlf.txt', 'one\r\nTWO\r\nthree\r\nfour\r\n');
  put('f.bom.js', '\ufeffconst a = 10;\nconst b = 2;\n');
  fs.unlinkSync(path.join(ws, 'g.txt'));
  put('new.js', 'console.log(1);\n');

  const expected = ['a.json', 'b.js', 'c.py', 'd.css', 'e.crlf.txt', 'f.bom.js', 'g.txt', 'new.js'];
  const detected = await until(() => {
    beat();
    const names = api._entries().map((e) => path.basename(e.file));
    return expected.every((n) => names.includes(n));
  }, 30000);
  check('the 8 changes are detected', detected, JSON.stringify(api._entries().map((e) => path.basename(e.file))));
  if (!detected) return;
  check('modified files are not mistaken for new files', !entry('b.js').isNew && !entry('a.json').isNew);
  check('new file is flagged as new', entry('new.js').isNew);
  check('deleted file is flagged as deleted', entry('g.txt').deleted);

  // ---- review view: content, and no syntax error invented by the mix of old and new lines
  const opened = [];
  for (const e of api._entries()) {
    const name = path.basename(e.file);
    const rev = api._review(e.file);
    if (e.exists) {
      const real = fs.readFileSync(e.file, 'utf8').replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
      const kept = rev.text.split('\n').filter((_, i) => rev.rows[i].kind !== 'old').join('\n');
      check(`review of ${name}: new lines are exactly the real file`, kept === real);
    }
    const old = rev.rows.filter((r) => r.kind === 'old').length;
    check(`review of ${name}: old line count matches`, old === e.removed, `${old} vs ${e.removed}`);
    if (e.exists) {
      const uri = vscode.Uri.from({ scheme: 'claude-review', path: '/' + name, query: JSON.stringify({ file: e.file }) });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
      opened.push({ name, uri });
    }
  }
  await sleep(6000); // language servers need a moment to publish diagnostics
  for (const { name, uri } of opened) {
    const d = vscode.languages.getDiagnostics(uri);
    check(
      `review of ${name}: no phantom diagnostics`,
      d.length === 0,
      d.map((x) => `L${x.range.start.line + 1} ${x.message}`).join(' | ')
    );
  }
  const langOf = (name) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'claude-review' && d.uri.path === '/' + name);
  check('review of a.json is plain text (json server would validate it)', langOf('a.json') && langOf('a.json').languageId === 'plaintext');
  check('review of b.js keeps syntax highlighting', langOf('b.js') && langOf('b.js').languageId === 'javascript');

  // ---- partial keep / undo must never leave a syntax error behind
  let e = entry('b.js');
  check('b.js has two separate changes', e.hunks.length === 2, JSON.stringify(e.hunks));
  await vscode.commands.executeCommand('claudeDiff.undoHunk', e.file, sigOf(e.hunks[1]));
  await sleep(1500);
  check('b.js still compiles after undoing only its last change', compiles(read('b.js')), read('b.js'));
  e = entry('b.js');
  check('b.js keeps exactly one pending change', e && e.hunks.length === 1, e && JSON.stringify(e.hunks));
  await vscode.commands.executeCommand('claudeDiff.undoHunk', e.file, sigOf(e.hunks[0]));
  await sleep(1500);
  check('b.js is back to its exact original after undoing every change', read('b.js') === ORIGINAL['b.js'] && !entry('b.js'), JSON.stringify(read('b.js')));

  e = entry('c.py');
  await vscode.commands.executeCommand('claudeDiff.undoHunk', e.file, sigOf(e.hunks[0]));
  await sleep(1500);
  check('c.py is back to its exact original', read('c.py') === ORIGINAL['c.py'], JSON.stringify(read('c.py')));

  // ---- whole-file undo restores the exact bytes (CRLF, BOM, deleted, new)
  await vscode.commands.executeCommand('claudeDiff.undoFile', entry('e.crlf.txt').file);
  await sleep(1500);
  check('undo keeps CRLF line endings', read('e.crlf.txt') === ORIGINAL['e.crlf.txt'], JSON.stringify(read('e.crlf.txt')));

  await vscode.commands.executeCommand('claudeDiff.undoFile', entry('f.bom.js').file);
  await sleep(1500);
  check('undo keeps the BOM', read('f.bom.js') === ORIGINAL['f.bom.js'], JSON.stringify(read('f.bom.js')));

  await vscode.commands.executeCommand('claudeDiff.undoFile', entry('g.txt').file);
  await sleep(1500);
  check('undo recreates a deleted file', fs.existsSync(path.join(ws, 'g.txt')) && read('g.txt') === ORIGINAL['g.txt']);

  await vscode.commands.executeCommand('claudeDiff.undoFile', entry('new.js').file);
  await sleep(1500);
  check('undo removes a file Claude created', !fs.existsSync(path.join(ws, 'new.js')));
  check('the last undo can be restored', api._hasUndo());

  // ---- keeping every change one by one leaves the file untouched
  const before = read('a.json');
  for (let i = 0; i < 10 && entry('a.json'); i++) {
    const cur = entry('a.json');
    await vscode.commands.executeCommand('claudeDiff.keepHunk', cur.file, sigOf(cur.hunks[0]));
    await sleep(600);
  }
  check('keeping every change clears the file and does not touch it', !entry('a.json') && read('a.json') === before);

  for (let i = 0; i < 10 && entry('d.css'); i++) {
    const cur = entry('d.css');
    await vscode.commands.executeCommand('claudeDiff.undoHunk', cur.file, sigOf(cur.hunks[cur.hunks.length - 1]));
    await sleep(900);
  }
  check('undoing every change of d.css returns the exact original', !entry('d.css') && read('d.css') === ORIGINAL['d.css'], JSON.stringify(read('d.css')));
  check('nothing is left to review', api._entries().length === 0, JSON.stringify(api._entries().map((x) => path.basename(x.file))));

  await fastClicks({ ws, api, put, read, entry, beat });

  await keyboardReview({ api, put, read, entry, beat });

  if (process.env.E2E_GIT) await gitScenarios({ ws, api, put, read, entry, beat });

  await userFileOps({ ws, api, put, entry, beat });

  // ---- a long Write: nothing in the transcript for minutes, then the file and the transcript at once
  const past = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(transcript, past, past);
  await sleep(3000); // Claude now looks idle
  put('wake-user.txt', 'changed by the user while Claude was silent\n');
  fs.utimesSync(path.join(ws, 'wake-user.txt'), Date.now() / 1000 - 60, Date.now() / 1000 - 60);
  put('wake-claude.js', 'console.log("a long file");\n');
  beat();
  const woke = await until(() => {
    beat();
    return entry('wake-claude.js');
  }, 30000);
  check('wake-up: a file Claude creates after a long silence is detected', woke && woke.isNew, JSON.stringify(api._entries().map((e) => path.basename(e.file))));
  check('wake-up: a file changed before Claude wakes up is not Claude\'s', !entry('wake-user.txt'), JSON.stringify(api._entries().map((e) => path.basename(e.file))));
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);

  // ---- a sub-agent at work: the session's transcript is silent, the sub-agent's is written
  const silent = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(transcript, silent, silent);
  await sleep(3000); // the extension now takes Claude for idle
  const subDir = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subBeat = () => fs.appendFileSync(path.join(subDir, 'agent-1.jsonl'), '{"t":1}\n');
  subBeat();
  await sleep(1500);
  put('sub-made.js', 'console.log("sub-agent");\n');
  const bySub = await until(() => {
    subBeat();
    return entry('sub-made.js');
  }, 30000);
  check('claude: a file created by a sub-agent is detected', bySub && bySub.isNew, api._entries().map((x) => path.basename(x.file)));
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
}

// Clicks made faster than the extension redraws its buttons (the later ones carry the coordinates of
// a file that has since moved). Every click must act on its own change, and no earlier one may be lost.
async function fastClicks({ api, put, read, entry, beat }) {
  const pending = async (f, n) =>
    until(() => {
      beat();
      const e = entry(f);
      return e && e.hunks.length === n;
    }, 30000);
  /** The buttons of a file as the review draws them: [file, signature, id] for each change. */
  const buttons = (f) => {
    const e = entry(f);
    const ids = hunkIds(e.baseline, e.text, e.hunks);
    return e.hunks.map((h, i) => [e.file, sigOf(h), ids[i]]);
  };
  const keep = (b) => vscode.commands.executeCommand('claudeDiff.keepHunk', ...b);
  const undo = (b) => vscode.commands.executeCommand('claudeDiff.undoHunk', ...b);
  const resolved = (f) => until(() => !entry(f), 15000);

  // 1. Keep, Keep, Keep without waiting: nothing may come back, in any order, with redraws in between
  const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]];
  for (let k = 1; k <= orders.length; k++) {
    put('r.txt', round(k));
    const ok = await pending('r.txt', 3);
    if (!ok) {
      check(`fast clicks, round ${k}: Claude's three changes are detected`, false, entry('r.txt') && JSON.stringify(entry('r.txt').hunks));
      return;
    }
    const b = buttons('r.txt');
    await Promise.all(orders[k - 1].flatMap((i) => [keep(b[i]), api._refresh()]));
    const done = await resolved('r.txt');
    check(
      `fast clicks, round ${k}: keeping the three changes in a row (${orders[k - 1]}) leaves nothing to review`,
      done && read('r.txt') === round(k),
      entry('r.txt') ? `still pending: ${JSON.stringify(entry('r.txt').hunks)}` : JSON.stringify(read('r.txt'))
    );
  }

  // 2. Keep, Undo, Keep on three changes of one file
  put('r2.txt', text('p1', 'P2a', 'P2b', 'p3', 'p4', 'p6', 'p7', 'P8', 'p9'));
  if (await pending('r2.txt', 3)) {
    const b = buttons('r2.txt');
    await Promise.all([keep(b[0]), undo(b[1]), keep(b[2])]);
    const done = await resolved('r2.txt');
    const want = text('p1', 'P2a', 'P2b', 'p3', 'p4', 'p5', 'p6', 'p7', 'P8', 'p9');
    check('fast clicks: Keep, Undo, Keep in a row act each on its own change', done && read('r2.txt') === want, JSON.stringify(read('r2.txt')) + (entry('r2.txt') ? ' (still pending)' : ''));
  } else check('fast clicks: three changes of r2.txt detected', false, JSON.stringify(entry('r2.txt') && entry('r2.txt').hunks));

  // 3. Keep one change then Undo file at once: the change just kept stays
  put('r3.txt', text('p1', 'P2a', 'P2b', 'p3', 'p4', 'p5', 'p6', 'p7', 'P8', 'p9'));
  if (await pending('r3.txt', 2)) {
    const b = buttons('r3.txt');
    await Promise.all([keep(b[0]), vscode.commands.executeCommand('claudeDiff.undoFile', b[0][0])]);
    const done = await resolved('r3.txt');
    const want = text('p1', 'P2a', 'P2b', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9');
    check('fast clicks: Undo file right after a Keep does not undo the change just kept', done && read('r3.txt') === want, JSON.stringify(read('r3.txt')));
  } else check('fast clicks: two changes of r3.txt detected', false, JSON.stringify(entry('r3.txt') && entry('r3.txt').hunks));

  // 4. A button drawn before Claude changed that very block again must not keep what it never showed
  put('r4.txt', text('p1', 'A', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'));
  if (await pending('r4.txt', 1)) {
    const b = buttons('r4.txt');
    put('r4.txt', text('p1', 'B', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'));
    await until(() => {
      beat();
      return entry('r4.txt') && entry('r4.txt').text.includes('B');
    }, 30000);
    await keep(b[0]);
    await sleep(1500);
    const e = entry('r4.txt');
    check('stale button: a block changed since it was drawn is not kept', e && e.baseline === ORIGINAL['r4.txt'] && e.hunks.length === 1, e ? JSON.stringify(e.baseline) : 'entry gone: B was kept unseen');
    if (e) {
      await vscode.commands.executeCommand('claudeDiff.undoFile', e.file);
      await sleep(1500);
    }
  } else check('fast clicks: the change of r4.txt is detected', false, JSON.stringify(entry('r4.txt') && entry('r4.txt').hunks));
  check('fast clicks: nothing is left to review', api._entries().length === 0, JSON.stringify(api._entries().map((x) => path.basename(x.file))));
}

// Reviewing with the keyboard (Ctrl+Y / Ctrl+N on the change under the cursor, Alt+F5 to the next
// change) and reverting a Keep or an Undo (Ctrl+Z in the review).
async function keyboardReview({ api, put, read, entry, beat }) {
  const K = ORIGINAL['k.txt'];
  // three changes: k2 replaced, k6 removed, a line added after k10
  const CLAUDE = text('k1', 'K2', 'k3', 'k4', 'k5', 'k7', 'k8', 'k9', 'k10', 'NEW', 'k11', 'k12');
  put('k.txt', CLAUDE);
  const ok = await until(() => {
    beat();
    const e = entry('k.txt');
    return e && e.hunks.length === 3;
  }, 30000);
  check('keyboard: the three changes of k.txt are detected', ok, JSON.stringify(entry('k.txt') && entry('k.txt').hunks));
  if (!ok) return;
  const file = entry('k.txt').file;
  const ed = () => vscode.window.activeTextEditor;
  const cursor = () => ed().selection.active.line;
  const starts = () => api._review(file).hunkRows;
  const inReview = () => ed() && ed().document.uri.scheme === 'claude-review';
  const settle = () => until(() => inReview() && ed().document.getText() === api._review(file).text, 5000, 50);
  const count = () => (entry('k.txt') ? entry('k.txt').hunks.length : 0);
  const put0 = (line) => {
    const p = new vscode.Position(line, 0);
    ed().selection = new vscode.Selection(p, p);
  };

  await vscode.commands.executeCommand('claudeDiff.openFile', file);
  await settle();
  check('keyboard: the review opens on the first change', inReview() && cursor() === starts()[0], `${cursor()} vs ${starts()}`);

  // not on a change: the key moves to the next change, keeps nothing
  put0(0);
  await vscode.commands.executeCommand('claudeDiff.keepHunk');
  check('keyboard: Keep with the cursor off any change only moves to the next one', count() === 3 && cursor() === starts()[0], `${count()} changes, line ${cursor()}`);

  // Keep at cursor, then the cursor is on the next change
  await vscode.commands.executeCommand('claudeDiff.keepHunk');
  await settle();
  const e1 = entry('k.txt');
  check('keyboard: Keep at cursor keeps that change only', e1 && e1.hunks.length === 2 && e1.baseline.includes('K2') && read('k.txt') === CLAUDE, e1 && JSON.stringify(e1.baseline));
  check('keyboard: after a Keep the cursor is on the next change', cursor() === starts()[0], `${cursor()} vs ${starts()}`);

  // Undo at cursor: k6 comes back
  await vscode.commands.executeCommand('claudeDiff.undoHunk');
  await settle();
  check('keyboard: Undo at cursor puts the old lines back', count() === 1 && read('k.txt').includes('k6\n'), JSON.stringify(read('k.txt')));
  const roles = api._review(file).rows.map((r) => r.kind[0]).join('');
  const shown = ed().document.getText();
  check('review after the Undo: the line put back is a plain line, not an old one', !roles.includes('o') && roles.split('n').length === 2 && shown === api._review(file).text, roles);
  check('keyboard: after an Undo the cursor is on the next change', cursor() === starts()[0], `${cursor()} vs ${starts()}`);

  // Ctrl+Z: revert the Undo, then the Keep
  await vscode.commands.executeCommand('claudeDiff.restoreLastUndo');
  await settle();
  check("revert: the last Undo is reverted (Claude's lines back, to review again)", read('k.txt') === CLAUDE && count() === 2, JSON.stringify(read('k.txt')));
  await vscode.commands.executeCommand('claudeDiff.restoreLastUndo');
  await settle();
  const e2 = entry('k.txt');
  check('revert: the Keep before it is reverted too (its change is to review again)', e2 && e2.hunks.length === 3 && e2.baseline === K, e2 && JSON.stringify(e2.baseline));

  // Alt+F5: next change, through the three of them, then around (only file to review)
  put0(0);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await vscode.commands.executeCommand('claudeDiff.nextChange');
    seen.push(cursor());
  }
  const s = starts();
  check('Alt+F5 goes from change to change, then back to the first', JSON.stringify(seen) === JSON.stringify([s[0], s[1], s[2], s[0]]), `${seen} vs ${s}`);
  await vscode.commands.executeCommand('claudeDiff.prevChange');
  check('Shift+Alt+F5 goes back around to the last change', cursor() === s[2], `${cursor()} vs ${s}`);

  // Keep file, then revert it: the whole review of the file comes back
  await vscode.commands.executeCommand('claudeDiff.keepFile', file);
  await until(() => !entry('k.txt'), 5000);
  check('revert: Keep file clears the file', !entry('k.txt'));
  await vscode.commands.executeCommand('claudeDiff.restoreLastUndo');
  await until(() => entry('k.txt'), 5000);
  check('revert: reverting Keep file brings its three changes back', count() === 3 && read('k.txt') === CLAUDE, count());

  // A revert never overwrites a file changed since the action
  await vscode.commands.executeCommand('claudeDiff.undoFile', file);
  await until(() => !entry('k.txt'), 5000);
  check('keyboard: Undo file restores the original', read('k.txt') === K, JSON.stringify(read('k.txt')));
  put('k.txt', K.replace('k1', 'mine'));
  await vscode.commands.executeCommand('claudeDiff.restoreLastUndo');
  await sleep(1500);
  check('revert: a file changed since is left alone', read('k.txt') === K.replace('k1', 'mine'), JSON.stringify(read('k.txt')));
  put('k.txt', K);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await until(() => {
    beat();
    return api._entries().length === 0;
  }, 10000);
  if (api._entries().length) {
    await vscode.commands.executeCommand('claudeDiff.keepAll');
    await sleep(1000);
  }
}

// git rewrites files while Claude is "active": that must never bring reviewed changes back.
async function gitScenarios({ ws, api, put, read, entry, beat }) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const names = () => JSON.stringify(api._entries().map((x) => path.basename(x.file)));
  /** Lets the extension poll for a while, Claude staying "active" all along. */
  const settle = async (ms) => {
    for (let t = 0; t < ms; t += 500) {
      beat();
      await sleep(500);
    }
  };
  // a branch prepared elsewhere (a second worktree): nothing is written in the workspace
  const branch = (name, files, message) => {
    const wt = path.join(os.tmpdir(), `claude-diff-wt-${name}-${Date.now()}`);
    git(ws, 'worktree', 'add', '-q', '-b', name, wt, 'HEAD');
    for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), s);
    git(wt, 'commit', '-q', '-am', message);
    git(ws, 'worktree', 'remove', '--force', wt);
  };

  const ONE = read('a.json'); // Claude's version, kept: a reviewed change
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'base');
  await settle(4000);
  check('git: a commit is not a change to review', api._entries().length === 0, names());

  const OTHER = '{"other": true}\n';
  branch('other', { 'a.json': OTHER, 'g.txt': 'keep me\nstay2\nm1\nm2\nm3\n' }, 'other');
  git(ws, 'checkout', '-q', 'other');
  await settle(6000);
  check("git: checkout of another branch is not Claude's change", api._entries().length === 0, names());
  check('git: checkout really rewrote the files', read('a.json') === OTHER);

  git(ws, 'checkout', '-q', 'main');
  await settle(6000);
  check("git: going back to the branch is not Claude's change either", api._entries().length === 0 && read('a.json') === ONE, names());

  git(ws, 'merge', '-q', 'other');
  await settle(6000);
  check("git: merge / pull is not Claude's change", api._entries().length === 0 && read('a.json') === OTHER, names());

  // Claude still gets caught afterwards, on the very files git just wrote
  put('a.json', '{"other": false}\n');
  const caught = await until(() => {
    beat();
    return entry('a.json');
  }, 30000);
  check("git: Claude's edit of a file git just wrote is still detected", caught && caught.hunks.length === 1, names());
  await vscode.commands.executeCommand('claudeDiff.keepFile', entry('a.json').file);
  await sleep(1500);

  // Claude's pending change stays reviewable when git rewrites the same file around it
  branch('up', { 'g.txt': 'keep me\nstay2\nm1\nm2\nm3x\n' }, 'up');
  put('g.txt', 'kept\nstay2\nm1\nm2\nm3\n');
  const pending = await until(() => {
    beat();
    return entry('g.txt');
  }, 30000);
  check("git: Claude's edit of g.txt is detected", !!pending, names());
  git(ws, 'checkout', '-q', '-m', 'up');
  await settle(6000);
  const g = entry('g.txt');
  check(
    "git: after a checkout, only Claude's own lines of g.txt are still to review",
    g && read('g.txt') === 'kept\nstay2\nm1\nm2\nm3x\n' && g.hunks.length === 1 && g.added === 1 && g.removed === 1,
    g ? `${JSON.stringify(read('g.txt'))} hunks=${JSON.stringify(g.hunks)}` : names()
  );
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
  check('git: nothing is left to review at the end', api._entries().length === 0, names());

  // By default a commit does not touch the review: it is not a review, and Claude may commit by itself
  put('b.js', 'default();\n');
  const waiting = await until(() => {
    beat();
    return entry('b.js');
  }, 30000);
  check('git: a change is pending before a commit made with the default setting', !!waiting, names());
  git(ws, 'commit', '-q', '-a', '-m', 'default setting');
  await settle(4000);
  check('git: by default a commit leaves the review alone', !!entry('b.js'), names());
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
  await vscode.workspace.getConfiguration('claudeDiff').update('clearReviewOnCommit', true, vscode.ConfigurationTarget.Global);
  await sleep(500);

  // With claudeDiff.clearReviewOnCommit, a commit keeps what it holds; what is not committed yet stays to review
  put('b.js', 'committed();\n');
  put('c.py', 'def f():\n    return 3\n');
  put('.gitignore', '.env\n');
  put('.env', 'SECRET=1\n');
  const four = await until(() => {
    beat();
    return api._entries().length >= 4;
  }, 30000);
  check('git: four changes are pending before the commit', four, names());
  git(ws, 'add', '.gitignore');
  git(ws, 'commit', '-q', '-m', 'only some files', 'b.js', '.gitignore');
  await settle(4000);
  check(
    'git: a commit keeps the files it holds, and only those',
    !entry('b.js') && !entry('.gitignore') && !!entry('c.py') && !!entry('.env'),
    names()
  );
  fs.unlinkSync(path.join(ws, 'd.css'));
  const gone = await until(() => {
    beat();
    const d = entry('d.css');
    return d && d.deleted;
  }, 30000);
  check('git: a deleted file is pending before the commit', gone, names());
  git(ws, 'commit', '-q', '-a', '-m', 'the rest');
  await settle(4000);
  check(
    'git: a commit keeps modified and deleted files, but not a git-ignored one it cannot hold',
    !entry('c.py') && !entry('d.css') && api._entries().length === 1 && !!entry('.env'),
    names()
  );
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
  check('git: nothing is left to review after the commits', api._entries().length === 0, names());

  // Claude edits and commits in the same breath: the commit happens before the extension saw the edit
  put('b.js', 'quick();\n');
  put('h.txt', 'brand new\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'edited and committed at once');
  await settle(8000);
  check('git: a change committed right after being made is not left to review', api._entries().length === 0, names());

  // ... and a change made after that commit is still caught
  put('b.js', 'quick();\nlater();\n');
  const later = await until(() => {
    beat();
    return entry('b.js');
  }, 30000);
  check('git: a change made after the commit is still detected', later && later.hunks.length === 1, names());
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);

  // Files git ignores (build output, screenshots...) can never be committed: a commit clears them,
  // except what looks like a secret, which stays to be looked at.
  fs.appendFileSync(path.join(ws, '.git', 'info', 'exclude'), '*.out\n');
  put('b.js', 'ignored();\n');
  put('x.out', 'build output\n');
  put('.env', 'SECRET=2\n');
  const three = await until(() => {
    beat();
    return api._entries().length >= 3;
  }, 30000);
  check('git: an ignored file is pending before the commit', three, names());
  git(ws, 'commit', '-q', '-a', '-m', 'with an ignored file around');
  await settle(4000);
  check(
    'git: a commit also clears git-ignored files, but not a secret',
    !entry('b.js') && !entry('x.out') && !!entry('.env') && api._entries().length === 1,
    names()
  );
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
  // ---- files created by the user (while Claude is working) are never Claude's changes
  const HEADER = '/*\n * File: header.js\n * Author: me\n */\n';
  const ghost = () => api._entries().filter((e) => /^user-/.test(path.basename(e.file))).map((e) => path.basename(e.file));
  const watch = async (ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      beat();
      await sleep(500);
    }
  };

  // Ctrl+N, a header inserted by another extension (Ctrl+Shift+H), then Save As
  const untitled = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:' + path.join(ws, 'user-untitled.js')));
  const ed1 = await vscode.window.showTextDocument(untitled);
  await ed1.edit((b) => b.insert(new vscode.Position(0, 0), HEADER + 'const a = 1;\n'));
  await untitled.save();
  await watch(5000);
  check('user: an untitled file saved with a header is not Claude\'s', fs.existsSync(path.join(ws, 'user-untitled.js')) && !ghost().includes('user-untitled.js'), ghost());

  // New file from the explorer (empty on disk), then the header is inserted and saved
  const target = vscode.Uri.file(path.join(ws, 'user-explorer.js'));
  const we = new vscode.WorkspaceEdit();
  we.createFile(target, { ignoreIfExists: true });
  await vscode.workspace.applyEdit(we);
  const doc2 = await vscode.workspace.openTextDocument(target);
  const ed2 = await vscode.window.showTextDocument(doc2);
  await watch(2500);
  await ed2.edit((b) => b.insert(new vscode.Position(0, 0), HEADER));
  await doc2.save();
  await watch(5000);
  check('user: a file created from the explorer, then given a header, is not Claude\'s', fs.existsSync(target.fsPath) && !ghost().includes('user-explorer.js'), ghost());

  // ... while a file Claude creates meanwhile is still detected
  put('user-claude.js', 'console.log("claude");\n');
  const still = await until(() => {
    beat();
    return entry('user-claude.js');
  }, 30000);
  check('user: a file created by Claude is still detected', still && still.isNew, ghost());
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
}

// Files the user deletes, moves or empties from VS Code while Claude is working.
async function userFileOps({ ws, api, put, entry, beat }) {
  const watch = async (ms) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      beat();
      await sleep(500);
    }
  };
  // ---- files deleted or moved by the user (explorer) while Claude is working
  fs.mkdirSync(path.join(ws, 'user-dir'), { recursive: true });
  for (const f of ['user-del.txt', 'user-dir/one.txt', 'user-dir/two.txt', 'user-mv.txt', 'user-edited.txt']) put(f, 'mine\n');
  const anyUser = () => api._entries().map((e) => path.relative(ws, e.file)).filter((r) => /user-/.test(r));
  await until(() => {
    beat();
    return anyUser().length === 5;
  }, 30000);
  await vscode.commands.executeCommand('claudeDiff.keepAll'); // now plain files of the project
  await watch(2000);
  check('user: setup leaves nothing to review', anyUser().length === 0, anyUser());
  const uri = (f) => vscode.Uri.file(path.join(ws, f));
  const wsEdit = async (fn) => {
    const e = new vscode.WorkspaceEdit();
    fn(e);
    await vscode.workspace.applyEdit(e);
  };
  await wsEdit((e) => e.deleteFile(uri('user-del.txt')));
  await watch(4000);
  check('user: a file deleted from the explorer is not Claude\'s', !fs.existsSync(path.join(ws, 'user-del.txt')) && anyUser().length === 0, anyUser());
  await wsEdit((e) => e.deleteFile(uri('user-dir'), { recursive: true }));
  await watch(4000);
  check('user: a folder deleted from the explorer is not Claude\'s', !fs.existsSync(path.join(ws, 'user-dir')) && anyUser().length === 0, anyUser());
  await wsEdit((e) => e.renameFile(uri('user-mv.txt'), uri('user-moved.txt')));
  await watch(4000);
  check('user: a file renamed from the explorer is not Claude\'s', fs.existsSync(path.join(ws, 'user-moved.txt')) && anyUser().length === 0, anyUser());

  // Claude changes a file, then the user deletes it: it leaves the review (not "deleted by Claude")
  put('user-edited.txt', 'mine\nclaude\n');
  const edited = await until(() => {
    beat();
    return entry('user-edited.txt');
  }, 30000);
  check('user: setup, a change of Claude is pending', edited && !edited.isNew, anyUser());
  await wsEdit((e) => e.deleteFile(uri('user-edited.txt')));
  await watch(4000);
  check('user: a file Claude changed, then deleted by the user, leaves the review', !entry('user-edited.txt'), anyUser());

  // An emptied untitled buffer does not make an empty file of Claude's look like the user's
  const scratch = await vscode.workspace.openTextDocument({ content: '' });
  const ed3 = await vscode.window.showTextDocument(scratch);
  await ed3.edit((b) => b.insert(new vscode.Position(0, 0), 'scratch'));
  await ed3.edit((b) => b.delete(new vscode.Range(0, 0, 0, 7)));
  put('user-empty.py', '');
  const empty = await until(() => {
    beat();
    return entry('user-empty.py');
  }, 30000);
  check('claude: an empty file is detected even next to an emptied untitled buffer', empty && empty.isNew, anyUser());
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('claudeDiff.keepAll');
  await sleep(1500);
}

async function run() {
  try {
    await main();
  } catch (err) {
    check('unexpected exception', false, (err && err.stack) || err);
  }
  fs.writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 2));
}

module.exports = { run };
