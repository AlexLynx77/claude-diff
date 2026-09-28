'use strict';
// Runs INSIDE the VS Code extension host (started by test/e2e/run.js).
// A fake Claude Code transcript makes the extension believe Claude is working, then the
// test edits files on disk the way Claude would and drives the extension's commands.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const ORIGINAL = {
  'a.json': '{\n  "name": "x",\n  "version": 1,\n  "list": [1, 2, 3]\n}\n',
  'b.js': 'function add(a, b) {\n  const s = a + b;\n  return s;\n}\nmodule.exports = { add };\n',
  'c.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n',
  'd.css': 'body {\n  color: red;\n}\n.a {\n  margin: 0;\n}\n',
  'e.crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  'f.bom.js': '\ufeffconst a = 1;\nconst b = 2;\n',
  'g.txt': 'keep me\nstay\n',
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
