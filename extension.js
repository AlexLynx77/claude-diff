'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { splitLines, detectEol, diffLines, planReplace } = require('./diff');
const { Activity, Tracker, norm } = require('./tracker');

const SCHEME = 'claude-diff';
/** Read-only review view of a file: old lines shown (greyed) right above the new ones. */
const REVIEW = 'claude-review';
/** Claude is considered active in a folder for this long after its last transcript write. */
const ACTIVE_MS = Number(process.env.CLAUDE_DIFF_ACTIVE_MS) || 2 * 60 * 1000;
/** Workspace scan period while Claude is not working (keeps the "before" contents current). */
const IDLE_SCAN_MS = 15 * 1000;
const LEGACY_HOOK_FILE = 'claude-diff-hook.js';

/**
 * @typedef {{aStart: number, aEnd: number, bStart: number, bEnd: number}} Hunk
 * @typedef {{
 *   file: string, baseline: string | null, bom: boolean, text: string, exists: boolean,
 *   isNew: boolean, deleted: boolean, hunks: Hunk[], added: number, removed: number,
 *   baseTs: number, snapshots: string[], rev: string
 * }} Entry
 */

const sigOf = (h) => `${h.aStart}:${h.aEnd}:${h.bStart}:${h.bEnd}`;
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const sameText = (a, b) => a.replace(/\r\n|\r/g, '\n') === b.replace(/\r\n|\r/g, '\n');
const hashOf = (s) => crypto.createHash('md5').update(s).digest('hex');
/** Resolves to undefined (and logs) if `promise` takes longer than `ms`: nothing may freeze the loop. */
let logWarn = () => {};
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        logWarn(`${label} did not finish within ${ms} ms, skipped`);
        resolve(undefined);
      }, ms);
    }),
  ]);
}
const closeTab = (tab) => withTimeout(vscode.window.tabGroups.close(tab, true).then(undefined, () => {}), 3000, 'closing a tab');
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Files with a pending change, keyed by norm(path). @type {Map<string, Entry>} */
let entries = new Map();
/** Every file that has a snapshot (pending review). */
let trackedFiles = new Set();
let trackedPaths = [];
/** Parsed snapshots, keyed by snapshot path. */
const snapCache = new Map();
/** Where snapshots are stored (per workspace, outside the project). */
let storeDir = '';
/** Re-scans and re-renders everything; assigned in activate(). @type {() => Promise<void>} */
let refresh = async () => {};
/** Updates the review bar; assigned in activate(). */
let showRestore = () => {};
/** @type {Tracker} */
let tracker;

const folderPaths = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);

// ---------------------------------------------------------------- snapshots

/** Snapshot folders: ours, plus the in-project folder used by versions <= 0.5. */
function snapshotDirs() {
  return [storeDir, ...folderPaths().map((f) => path.join(f, '.claude', 'claude-diff'))].filter(Boolean);
}

async function writeSnapshot(file, content, source) {
  await fs.promises.mkdir(storeDir, { recursive: true });
  const ts = Date.now();
  const id = crypto.createHash('sha1').update(norm(file)).digest('hex').slice(0, 16);
  const out = path.join(storeDir, `${id}.${ts}.json`);
  const snap = { version: 2, ts, file, existed: content !== null, content, source };
  await fs.promises.writeFile(out + '.tmp', JSON.stringify(snap));
  await fs.promises.rename(out + '.tmp', out);
  trackedFiles.add(norm(file));
}

async function readSnapshots() {
  /** @type {Map<string, any[]>} */
  const byFile = new Map();
  const alive = new Set();
  for (const dir of snapshotDirs()) {
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(dir, name);
      alive.add(p);
      let snap = snapCache.get(p);
      if (!snap) {
        try {
          snap = JSON.parse(await fs.promises.readFile(p, 'utf8'));
          snap.path = p;
          snapCache.set(p, snap);
        } catch {
          continue; // half-written or corrupt snapshot
        }
      }
      if (typeof snap.file !== 'string') continue;
      const key = norm(snap.file);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(snap);
    }
  }
  for (const p of [...snapCache.keys()]) if (!alive.has(p)) snapCache.delete(p);
  return byFile;
}

async function discard(paths) {
  for (const p of paths) snapCache.delete(p);
  await Promise.all(paths.map((p) => fs.promises.rm(p, { force: true })));
}

function openDocFor(file) {
  const key = norm(file);
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === key
  );
}

/** Open, unmodified buffers whose content on disk is newer; filled by scan(). */
let staleDocs = [];
/** Last disk state we asked VS Code to reload, per file, to never loop on undecodable files. */
const reloaded = new Map(); // fsPath -> {stamp, tries}

async function scan() {
  staleDocs = [];
  const byFile = await readSnapshots();
  trackedFiles = new Set(byFile.keys());
  trackedPaths = [...byFile.values()].map((snaps) => snaps[0].file);
  const next = new Map();
  for (const [key, snaps] of byFile) {
    snaps.sort((a, b) => a.ts - b.ts);
    const base = snaps[0];
    const file = base.file;
    const rawBaseline = base.existed ? base.content : null;
    const bom = rawBaseline !== null && rawBaseline.charCodeAt(0) === 0xfeff;
    const baseline = rawBaseline === null ? null : stripBom(rawBaseline);

    const doc = openDocFor(file);
    let disk = null;
    try {
      disk = stripBom(await fs.promises.readFile(file, 'utf8'));
    } catch {
      // file does not exist
    }
    let text;
    if (doc && !(doc.isDirty === false && disk === null)) {
      text = doc.getText();
      // A clean buffer that differs from disk is stale (missed file event, common over WSL/SSH):
      // diff against the disk and ask VS Code to reload it.
      if (!doc.isDirty && disk !== null && !sameText(disk, text)) {
        text = disk;
        staleDocs.push({ uri: doc.uri, stamp: disk.length + ':' + hashOf(disk) });
      }
    } else {
      text = disk || '';
    }
    const exists = doc ? !(doc.isDirty === false && disk === null) : disk !== null;

    /** @type {Hunk[]} */
    let hunks;
    if (baseline === null) {
      if (!exists) {
        await discard(snaps.map((s) => s.path)); // created then removed: nothing to review
        continue;
      }
      const lines = splitLines(text);
      const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      hunks = [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: count }];
    } else {
      hunks = diffLines(splitLines(baseline), exists ? splitLines(text) : []);
    }
    const deleted = baseline !== null && !exists;

    if (!hunks.length && !deleted) {
      // Back to its original content (reverted, or every change kept/undone one by one).
      await discard(snaps.map((s) => s.path));
      continue;
    }

    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      added += h.bEnd - h.bStart;
      removed += h.aEnd - h.aStart;
    }
    next.set(key, {
      file,
      baseline,
      bom,
      text,
      exists,
      isNew: baseline === null,
      deleted,
      hunks,
      added,
      removed,
      baseTs: base.ts,
      snapshots: snaps.map((s) => s.path),
      rev: crypto.createHash('md5').update(baseline || '').digest('hex').slice(0, 8),
    });
  }
  entries = next;
  trackedFiles = new Set(entries.keys());
}

/** Cheap signature of the pending files (snapshot folders + files on disk + open buffers). */
async function fingerprint() {
  const parts = [];
  for (const dir of snapshotDirs()) {
    try {
      parts.push((await fs.promises.readdir(dir)).sort().join(','));
    } catch {
      parts.push('-');
    }
  }
  for (const file of trackedPaths) {
    const doc = openDocFor(file);
    const buffer = doc ? `:v${doc.version}:${doc.isDirty}` : '';
    try {
      const st = await fs.promises.stat(file);
      parts.push(`${file}${buffer}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${file}${buffer}:gone`);
    }
  }
  return parts.join('|');
}

const ordered = () => [...entries.values()].sort((a, b) => a.baseTs - b.baseTs || a.file.localeCompare(b.file));
const entryForUri = (uri) => {
  if (!uri) return undefined;
  if (uri.scheme === 'file') return entries.get(norm(uri.fsPath));
  if (uri.scheme === REVIEW) return entries.get(norm(fileOfReview(uri)));
  return undefined;
};

/** The entry for a document, only if its buffer is what was analysed (never mark stale text). */
function liveEntry(doc) {
  const entry = entryForUri(doc.uri);
  return entry && sameText(doc.getText(), entry.text) ? entry : undefined;
}

/** Accepts an entry, a file path, a Uri (editor title menu) or nothing (active editor). */
function entryFromArg(arg) {
  if (arg && typeof arg === 'object' && 'hunks' in arg && 'file' in arg) return arg;
  if (typeof arg === 'string') return entries.get(norm(arg));
  if (arg instanceof vscode.Uri) return entryForUri(arg);
  const ed = vscode.window.activeTextEditor;
  return ed && entryForUri(ed.document.uri);
}

function findHunk(fileArg, sig) {
  const entry = entryFromArg(fileArg);
  const hunk = entry && entry.hunks.find((h) => sigOf(h) === sig);
  return [entry, hunk];
}

// ---------------------------------------------------------------- review view

/**
 * The file as it is now, with the lines Claude removed or replaced inserted right above the
 * new ones. rows[i] describes line i: kind 'old' | 'new' | 'same', hunk index, real line.
 */
function buildReview(entry) {
  const A = entry.baseline === null ? [] : splitLines(entry.baseline);
  const B = entry.exists ? splitLines(entry.text) : [];
  const lines = [];
  const rows = [];
  const hunkRows = [];
  const push = (line, kind, hunk, real) => {
    lines.push(line);
    rows.push({ kind, hunk, real });
  };
  let bi = 0;
  entry.hunks.forEach((h, k) => {
    for (; bi < h.bStart; bi++) push(B[bi], 'same', -1, bi);
    hunkRows.push(lines.length);
    for (let a = h.aStart; a < h.aEnd; a++) push(A[a], 'old', k, -1);
    for (; bi < h.bEnd; bi++) push(B[bi], 'new', k, bi);
  });
  for (; bi < B.length; bi++) push(B[bi], 'same', -1, bi);
  return { text: lines.join('\n'), rows, hunkRows };
}

function reviewUri(file) {
  return vscode.Uri.from({
    scheme: REVIEW,
    // Just the file name, like any file in the editor (the real path is in the query):
    // same tab name and icon, syntax highlighting from the extension.
    path: '/' + path.basename(file),
    query: JSON.stringify({ file }),
  });
}

const fileOfReview = (uri) => {
  try {
    return JSON.parse(uri.query).file;
  } catch {
    return '';
  }
};

/** Last review built per file, used by decorations and CodeLens. */
const reviewModels = new Map();

function reviewModel(file) {
  const entry = entries.get(norm(file));
  if (!entry) return null;
  const model = buildReview(entry);
  reviewModels.set(norm(file), model);
  return model;
}

class ReviewProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
  }
  provideTextDocumentContent(uri) {
    const file = fileOfReview(uri);
    const model = reviewModel(file);
    if (model) return model.text;
    reviewModels.delete(norm(file));
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
  /** Updates the open review documents whose content changed. */
  refresh() {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== REVIEW) continue;
      const entry = entries.get(norm(fileOfReview(doc.uri)));
      const next = entry ? buildReview(entry).text : null;
      if (next === null || next !== doc.getText()) this._emitter.fire(doc.uri);
    }
  }
}

// ---------------------------------------------------------------- actions

function diffUri(entry, side) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: '/' + path.basename(entry.file),
    query: JSON.stringify({ file: entry.file, rev: entry.rev, side }),
  });
}

async function openDiff(entry) {
  const right = entry.exists ? vscode.Uri.file(entry.file) : diffUri(entry, 'empty');
  await vscode.commands.executeCommand(
    'vscode.diff',
    diffUri(entry, 'before'),
    right,
    `${path.basename(entry.file)} (before Claude ↔ now)`
  );
}

const reviewEnabled = () => vscode.workspace.getConfiguration('claudeDiff').get('reviewView', true);
/** Files the user chose to edit ("Edit file"): not redirected to the review view. */
const editing = new Set();

/** Opens a changed file: in the review view (old lines above new ones), or the file itself. */
async function openFile(entry, preserveFocus = false, viewColumn) {
  const useReview = reviewEnabled() && !editing.has(norm(entry.file));
  if (!useReview && !entry.exists) return openDiff(entry);
  const uri = useReview ? reviewUri(entry.file) : vscode.Uri.file(entry.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus, viewColumn });
  const model = useReview ? reviewModels.get(norm(entry.file)) || reviewModel(entry.file) : null;
  const line = model ? model.hunkRows[0] : entry.hunks[0] && entry.hunks[0].bStart;
  if (line !== undefined) {
    const pos = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Opens the real file to edit it (from the review view). */
async function editFile(arg) {
  const entry = entryFromArg(arg);
  const file = entry ? entry.file : typeof arg === 'string' ? arg : '';
  if (!file) return;
  editing.add(norm(file));
  const ed = vscode.window.activeTextEditor;
  let line = 0;
  if (ed && ed.document.uri.scheme === REVIEW) {
    const model = reviewModels.get(norm(file));
    const rows = model ? model.rows : [];
    for (let i = ed.selection.active.line; i >= 0 && rows[i]; i--) {
      if (rows[i].real >= 0) {
        line = rows[i].real;
        break;
      }
    }
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function activeKey() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return '';
  const uri = ed.document.uri;
  if (uri.scheme === 'file') return norm(uri.fsPath);
  if (uri.scheme === SCHEME || uri.scheme === REVIEW) return norm(fileOfReview(uri));
  return '';
}

/** Moves to the next/previous changed file. Never keeps or undoes anything. */
async function goToFile(direction) {
  const list = ordered();
  if (!list.length) {
    vscode.window.setStatusBarMessage('$(check) Claude Diff: nothing left to review', 3000);
    return;
  }
  const idx = list.findIndex((e) => norm(e.file) === activeKey());
  const next =
    idx < 0
      ? list[direction > 0 ? 0 : list.length - 1]
      : list[(idx + direction + list.length) % list.length];
  await openFile(next);
}

/**
 * What the last undo overwrote (Claude's version of each file + its snapshots), so that
 * "Restore" can put it back. Kept in memory until the next undo or window reload.
 * @type {{ files: {file: string, content: string | null, snaps: {path: string, raw: string}[]}[] } | null}
 */
let lastUndo = null;

async function backupOf(entry) {
  let content = null;
  const doc = openDocFor(entry.file);
  if (doc && doc.isDirty) {
    content = doc.getText();
  } else {
    try {
      content = await fs.promises.readFile(entry.file, 'utf8');
    } catch {
      // file does not exist (Claude deleted it)
    }
  }
  const snaps = [];
  for (const p of entry.snapshots) {
    try {
      snaps.push({ path: p, raw: await fs.promises.readFile(p, 'utf8') });
    } catch {
      // already gone
    }
  }
  return { file: entry.file, content, snaps };
}

/** Restores a whole file to its state before Claude touched it. */
async function restoreFile(entry) {
  const uri = vscode.Uri.file(entry.file);
  tracker.expect(entry.file, entry.isNew ? null : entry.baseline);
  if (entry.isNew) {
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
  } else {
    const open = openDocFor(entry.file);
    if (open && open.isDirty) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), entry.baseline);
      await vscode.workspace.applyEdit(edit);
      await open.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(entry.file)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from((entry.bom ? '﻿' : '') + entry.baseline, 'utf8'));
    }
  }
  await tracker.refresh(entry.file);
  trackedFiles.delete(norm(entry.file));
  await discard(entry.snapshots);
}

/** Undoes whole files, remembering Claude's version so that it can be restored. */
async function undoFiles(list) {
  const backups = [];
  for (const entry of list) {
    try {
      const backup = await backupOf(entry);
      await restoreFile(entry);
      backups.push(backup);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Diff: ${path.basename(entry.file)}: ${e.message}`);
    }
  }
  if (!backups.length) return;
  lastUndo = { files: backups };
  showRestore(backups.length);
}

/** Puts back what the last undo removed: Claude's version of the files, still pending review. */
async function restoreLastUndo() {
  const undo = lastUndo;
  if (!undo) return;
  lastUndo = null;
  showRestore(0);
  for (const f of undo.files) {
    const uri = vscode.Uri.file(f.file);
    tracker.expect(f.file, f.content);
    if (f.content === null) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        // already gone
      }
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(f.file)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(f.content, 'utf8'));
    }
    await tracker.refresh(f.file);
    for (const s of f.snaps) {
      await fs.promises.mkdir(path.dirname(s.path), { recursive: true });
      await fs.promises.writeFile(s.path, s.raw);
    }
  }
  await refresh();
}

async function keepEntries(list) {
  for (const e of list) trackedFiles.delete(norm(e.file));
  await discard(list.flatMap((e) => e.snapshots));
}

/** Keeps or undoes one file; when it was the file on screen, moves on to the next one. */
async function fileAction(arg, verb) {
  const entry = entryFromArg(arg);
  if (!entry) return;
  const ed = vscode.window.activeTextEditor;
  // A review tab moves on by itself once its file is resolved (see closeResolvedReviews).
  const wasActive = activeKey() === norm(entry.file) && ed.document.uri.scheme !== REVIEW;
  const list = ordered();
  const at = list.findIndex((e) => e === entry);
  const following = [...list.slice(at + 1), ...list.slice(0, at)][0];

  if (verb === 'undo') await undoFiles([entry]);
  else await keepEntries([entry]);
  await refresh();
  const target = following && entries.get(norm(following.file));
  if (wasActive && target) await openFile(target);
}

async function bulkAction(verb) {
  const list = ordered();
  if (!list.length) return;
  // No confirmation dialog: an undo can be reverted with "Restore".
  if (verb === 'undo') await undoFiles(list);
  else await keepEntries(list);
  await refresh();
}

async function writeBaseline(entry, content) {
  const [first, ...rest] = entry.snapshots;
  const snap = JSON.parse(await fs.promises.readFile(first, 'utf8'));
  snap.content = content;
  snap.existed = true;
  await fs.promises.writeFile(first + '.tmp', JSON.stringify(snap));
  await fs.promises.rename(first + '.tmp', first);
  snapCache.delete(first);
  await discard(rest);
}

/** Accept one hunk: fold it into the baseline. */
async function keepHunk(fileArg, sig) {
  const [entry, hunk] = findHunk(fileArg, sig);
  if (!entry || !hunk) return refresh();
  if (entry.isNew || entry.deleted) return fileAction(entry, 'keep');
  const base = splitLines(entry.baseline);
  base.splice(hunk.aStart, hunk.aEnd - hunk.aStart, ...splitLines(entry.text).slice(hunk.bStart, hunk.bEnd));
  await writeBaseline(entry, (entry.bom ? '﻿' : '') + base.join(detectEol(entry.baseline)));
  await refresh();
}

/** Reject one hunk: put the original lines back into the document. */
async function undoHunk(fileArg, sig) {
  const [entry, hunk] = findHunk(fileArg, sig);
  if (!entry || !hunk) return refresh();
  if (entry.isNew || entry.deleted) return fileAction(entry, 'undo');

  const uri = vscode.Uri.file(entry.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.getText() !== entry.text) {
    vscode.window.setStatusBarMessage('$(warning) Claude Diff: the file changed, review it again', 4000);
    return refresh();
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const original = splitLines(entry.baseline).slice(hunk.aStart, hunk.aEnd);
  const p = planReplace(splitLines(entry.text), hunk.bStart, hunk.bEnd, original, eol);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(p.sl, p.sc, p.el, p.ec), p.text);
  await vscode.workspace.applyEdit(edit);
  tracker.expect(entry.file, doc.getText());
  await doc.save();
  await tracker.refresh(entry.file);
  await refresh();
}

// ---------------------------------------------------------------- legacy cleanup (<= 0.5 used a hook)

function settingsFiles() {
  return [
    path.join(os.homedir(), '.claude', 'settings.json'),
    ...folderPaths().flatMap((f) => [
      path.join(f, '.claude', 'settings.json'),
      path.join(f, '.claude', 'settings.local.json'),
    ]),
  ];
}

/** Removes the Claude Code hook installed by older versions: it is not needed anymore. */
async function removeLegacyHooks() {
  const cleaned = [];
  for (const file of settingsFiles()) {
    let json;
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      if (!raw.includes(LEGACY_HOOK_FILE)) continue;
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const hooks = json.hooks || {};
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      hooks[event] = hooks[event].filter(
        (g) => !(g.hooks || []).some((h) => String(h.command || '').includes(LEGACY_HOOK_FILE))
      );
      if (!hooks[event].length) delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete json.hooks;
    await fs.promises.writeFile(file, JSON.stringify(json, null, 2) + '\n');
    cleaned.push(file);
  }
  return cleaned;
}

/** Deletes the old in-project snapshot folder once nothing in it is pending anymore. */
async function removeLegacyDirs() {
  for (const f of folderPaths()) {
    const dir = path.join(f, '.claude', 'claude-diff');
    try {
      const names = await fs.promises.readdir(dir);
      const pending = names.some((n) => n.endsWith('.json') && n !== 'turn-start.json');
      if (!pending) await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // absent
    }
  }
}

// ---------------------------------------------------------------- providers

class ChangesProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
  }
  /** @param {Entry} entry */
  getTreeItem(entry) {
    const uri = vscode.Uri.file(entry.file);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(vscode.workspace.asRelativePath(uri, false));
    const tag = entry.isNew ? 'new' : entry.deleted ? 'deleted' : `+${entry.added} −${entry.removed}`;
    item.description = [dir === '.' ? '' : dir, tag].filter(Boolean).join(' · ');
    item.tooltip = entry.file;
    item.contextValue = 'claudeFile';
    item.command = { command: 'claudeDiff.openFile', title: 'Open', arguments: [entry] };
    return item;
  }
  getChildren(element) {
    return element ? [] : ordered();
  }
}

class BeforeContentProvider {
  provideTextDocumentContent(uri) {
    const { file, side } = JSON.parse(uri.query || '{}');
    if (side !== 'before') return '';
    const entry = entries.get(norm(file));
    return entry && entry.baseline !== null ? entry.baseline : '';
  }
}

class ReviewLenses {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
  }
  provideCodeLenses(doc) {
    const inReview = doc.uri.scheme === REVIEW;
    const entry = inReview ? entryForUri(doc.uri) : liveEntry(doc);
    if (!entry) return [];
    const model = inReview ? reviewModels.get(norm(entry.file)) : null;
    if (inReview && (!model || model.text !== doc.getText())) return []; // content being updated
    const list = ordered();
    const pos = list.findIndex((e) => e === entry) + 1;
    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (range, title, command, args, tooltip) =>
      new vscode.CodeLens(range, { title, command, arguments: args, tooltip });

    const what = entry.isNew ? 'new file' : plural(entry.hunks.length, 'change');
    const lenses = [
      lens(top, `$(sparkle) Claude · ${what} · file ${pos} of ${list.length}`, 'claudeDiff.pickFile', [], 'Pick a changed file'),
    ];
    if (list.length > 1) {
      lenses.push(
        lens(top, '$(chevron-left) Previous', 'claudeDiff.prevFile', [], 'Previous changed file (nothing is kept or undone)'),
        lens(top, 'Next $(chevron-right)', 'claudeDiff.nextFile', [], 'Next changed file (nothing is kept or undone)')
      );
    }
    lenses.push(
      lens(top, '$(check) Keep file', 'claudeDiff.keepFile', [entry.file], "Keep Claude's changes in this file"),
      lens(top, '$(discard) Undo file', 'claudeDiff.undoFile', [entry.file], 'Restore this file as it was before Claude')
    );
    if (inReview && entry.exists) {
      lenses.push(lens(top, '$(edit) Edit file', 'claudeDiff.editFile', [entry.file], 'Open the file itself to edit it'));
    } else if (!inReview && reviewEnabled()) {
      lenses.push(lens(top, '$(eye) Review', 'claudeDiff.reviewFile', [entry.file], 'Show the old lines above the new ones'));
    }
    if (entry.isNew || entry.deleted) return lenses; // the whole file is one change
    const noun = (h) => {
      const a = h.aEnd - h.aStart;
      const b = h.bEnd - h.bStart;
      if (!a) return `${plural(b, 'line')} added`;
      if (!b) return `${plural(a, 'line')} removed`;
      return `${plural(a, 'line')} → ${plural(b, 'line')}`;
    };
    entry.hunks.forEach((h, k) => {
      const at = inReview ? model.hunkRows[k] : h.bStart;
      const line = Math.max(0, Math.min(at, doc.lineCount - 1));
      const r = new vscode.Range(line, 0, line, 0);
      const args = [entry.file, sigOf(h)];
      lenses.push(
        lens(r, '$(check) Keep', 'claudeDiff.keepHunk', args, 'Keep this change'),
        lens(r, '$(discard) Undo', 'claudeDiff.undoHunk', args, 'Put the old lines back'),
        lens(r, noun(h), '', [], '')
      );
    });
    return lenses;
  }
}

/** Coloured dot next to files (Explorer, tabs) and their parent folders while changes await review. */
class PendingDecorations {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._emitter.event;
    /** Files that had a decoration at the last refresh. @type {Set<string>} */
    this._shown = new Set();
  }
  enabled() {
    return vscode.workspace.getConfiguration('claudeDiff').get('showExplorerDot', true);
  }
  provideFileDecoration(uri) {
    const entry = this.enabled() ? entryForUri(uri) : undefined;
    if (!entry) return undefined;
    const what = entry.isNew ? 'New file created by Claude' : entry.deleted ? 'Deleted by Claude' : 'Changed by Claude';
    const d = new vscode.FileDecoration(
      '●',
      `${what} — waiting for review`,
      new vscode.ThemeColor('claudeDiff.pendingForeground')
    );
    d.propagate = true; // folders containing pending files get the colour too
    return d;
  }
  /** Tell VS Code which files (and their folders) may have changed decoration. */
  refresh() {
    const now = new Set(this.enabled() ? [...entries.values()].map((e) => e.file) : []);
    const touched = new Set([...this._shown, ...now]);
    this._shown = now;
    const roots = folderPaths();
    const uris = new Map();
    for (const file of touched) {
      let cur = file;
      for (;;) {
        uris.set(norm(cur), cur);
        const parent = path.dirname(cur);
        if (parent === cur || roots.some((r) => norm(r) === norm(cur))) break;
        cur = parent;
      }
    }
    if (uris.size) this._emitter.fire([...uris.values()].map((p) => vscode.Uri.file(p)));
  }
}

class RemovedHover {
  provideHover(doc, position) {
    const entry = liveEntry(doc);
    if (!entry || entry.isNew) return undefined;
    const baseLines = splitLines(entry.baseline);
    for (const h of entry.hunks) {
      if (h.aEnd <= h.aStart) continue;
      const first = Math.min(h.bStart, doc.lineCount - 1);
      const last = Math.max(h.bEnd - 1, first);
      if (position.line < first || position.line > last) continue;

      const removed = baseLines.slice(h.aStart, h.aEnd);
      const shown = removed.slice(0, 40).map((l) => '- ' + l);
      if (removed.length > 40) shown.push(`… ${removed.length - 40} more line(s)`);
      const args = encodeURIComponent(JSON.stringify([entry.file, sigOf(h)]));
      const md = new vscode.MarkdownString();
      md.isTrusted = { enabledCommands: ['claudeDiff.keepHunk', 'claudeDiff.undoHunk'] };
      md.appendMarkdown('**Removed or replaced by Claude**\n');
      md.appendCodeblock(shown.join('\n'), 'diff');
      md.appendMarkdown(
        `[$(check) Keep](command:claudeDiff.keepHunk?${args}) &nbsp;|&nbsp; [$(discard) Undo](command:claudeDiff.undoHunk?${args})`
      );
      md.supportThemeIcons = true;
      return new vscode.Hover(md);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- activation

async function activate(context) {
  storeDir = (context.storageUri || context.globalStorageUri).fsPath;
  const log = vscode.window.createOutputChannel('Claude Diff', { log: true });
  context.subscriptions.push(log);
  logWarn = (m) => log.warn(m);
  log.info(`activated (workspace: ${folderPaths().join(', ') || 'none'}, store: ${storeDir})`);

  const config = () => vscode.workspace.getConfiguration('claudeDiff');
  tracker = new Tracker({
    exclude: () => config().get('exclude', []),
    skip: (p) => norm(p).endsWith(norm(path.join('.claude', 'claude-diff'))),
  });
  const activity = new Activity();

  const provider = new ChangesProvider();
  const lenses = new ReviewLenses();
  const reviewProvider = new ReviewProvider();
  const decorations = new PendingDecorations();
  const view = vscode.window.createTreeView('claudeDiff.changes', { treeDataProvider: provider });

  // ---- review bar (status bar): ‹ file 2/5 ›  Keep  Undo  Keep All  Undo All
  const bar = {};
  const barItem = (name, priority, command, text, tooltip) => {
    const item = vscode.window.createStatusBarItem(`claudeDiff.${name}`, vscode.StatusBarAlignment.Left, priority);
    item.name = `Claude Diff: ${name}`;
    item.command = command;
    item.text = text;
    item.tooltip = tooltip;
    bar[name] = item;
    context.subscriptions.push(item);
    return item;
  };
  barItem('prev', 1001, 'claudeDiff.prevFile', '$(chevron-left)', 'Previous changed file (nothing is kept or undone)');
  barItem('files', 1000, 'claudeDiff.pickFile', '', 'Files changed by Claude — click to pick one');
  barItem('next', 999, 'claudeDiff.nextFile', '$(chevron-right)', 'Next changed file (nothing is kept or undone)');
  barItem('keep', 998, 'claudeDiff.keepFile', '$(check) Keep', "Keep Claude's changes in this file");
  barItem('undo', 997, 'claudeDiff.undoFile', '$(discard) Undo', 'Restore this file as it was before Claude');
  barItem('keepAll', 996, 'claudeDiff.keepAll', '$(check-all) Keep All', "Keep all of Claude's changes");
  barItem('undoAll', 995, 'claudeDiff.undoAll', '$(discard) Undo All', 'Undo all of Claude\'s changes (can be restored)');
  barItem('restore', 994, 'claudeDiff.restoreLastUndo', '$(history) Restore', '');
  bar.files.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  const setVisible = (item, on) => {
    item.visibleNow = on;
    if (on) item.show();
    else item.hide();
  };

  let restoreTimer;
  showRestore = (count) => {
    clearTimeout(restoreTimer);
    if (!count) {
      setVisible(bar.restore, false);
      return;
    }
    bar.restore.tooltip = `Put back Claude's version of the ${plural(count, 'file')} you just undid`;
    setVisible(bar.restore, true);
    restoreTimer = setTimeout(() => setVisible(bar.restore, false), 60 * 1000);
  };

  const updateBar = () => {
    const list = ordered();
    const n = list.length;
    const idx = list.findIndex((e) => norm(e.file) === activeKey());
    const onFile = idx >= 0;
    bar.files.text = onFile
      ? `$(sparkle) Claude · file ${idx + 1}/${n}`
      : `$(sparkle) Claude · ${plural(n, 'file')} to review`;
    for (const name of ['files', 'keepAll', 'undoAll']) setVisible(bar[name], n > 0);
    for (const name of ['prev', 'next']) setVisible(bar[name], n > 1 || (n > 0 && !onFile));
    for (const name of ['keep', 'undo']) setVisible(bar[name], onFile);
    vscode.commands.executeCommand('setContext', 'claudeDiff.activeFileHasChanges', onFile);
    vscode.commands.executeCommand('setContext', 'claudeDiff.hasChanges', n > 0);
  };

  // ---- in-editor decorations
  const themed = (id) => new vscode.ThemeColor(id);
  const addedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: themed('diffEditor.insertedLineBackground'),
    borderColor: themed('editorGutter.addedBackground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: themed('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const deletionType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: themed('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    overviewRulerColor: themed('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  // Review view: old lines greyed out on a "removed" background, new lines on an "added" one.
  // No left border there: the line numbers and the −/+ signs are drawn at the start of the line.
  const oldType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    opacity: '0.55',
    backgroundColor: themed('diffEditor.removedLineBackground'),
    overviewRulerColor: themed('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const newType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: themed('diffEditor.insertedLineBackground'),
    overviewRulerColor: themed('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  // Line numbers of the review view: those of the real file; old lines have none.
  const numberType = vscode.window.createTextEditorDecorationType({});

  const decorate = (editor) => {
    const doc = editor.document;
    const added = [];
    const deletions = [];
    const old = [];
    const numbers = [];
    const fresh = [];
    if (doc.uri.scheme === REVIEW) {
      // VS Code's own numbers would count the old lines: hide them in this editor only.
      if (editor.options.lineNumbers !== vscode.TextEditorLineNumbersStyle.Off) {
        editor.options = { lineNumbers: vscode.TextEditorLineNumbersStyle.Off };
      }
      const model = reviewModels.get(norm(fileOfReview(doc.uri)));
      if (model && model.text === doc.getText()) {
        const width = String(model.rows.reduce((m, r) => Math.max(m, r.real + 1), 1)).length;
        const pad = (s) => ' '.repeat(Math.max(0, width - s.length)) + s;
        model.rows.forEach((r, i) => {
          const range = new vscode.Range(i, 0, i, 0);
          if (r.kind === 'old') old.push(range);
          if (r.kind === 'new') fresh.push(range);
          const sign = r.kind === 'old' ? '−' : r.kind === 'new' ? '+' : ' ';
          numbers.push({
            range,
            renderOptions: {
              before: {
                contentText: `${pad(r.real >= 0 ? String(r.real + 1) : '')} ${sign}  `,
                color: themed(r.kind === 'same' ? 'editorLineNumber.foreground' : 'editorLineNumber.activeForeground'),
              },
            },
          });
        });
      }
    } else {
      const entry = liveEntry(doc);
      for (const h of entry ? entry.hunks : []) {
        const first = Math.min(h.bStart, doc.lineCount - 1);
        if (h.bEnd > h.bStart) {
          added.push(new vscode.Range(first, 0, Math.min(h.bEnd, doc.lineCount) - 1, 0));
        } else {
          deletions.push(new vscode.Range(first, 0, first, 0));
        }
      }
    }
    editor.setDecorations(addedType, added);
    editor.setDecorations(deletionType, deletions);
    editor.setDecorations(oldType, old);
    editor.setDecorations(numberType, numbers);
    editor.setDecorations(newType, fresh);
  };

  let firstLoad = true;
  let seen = new Set();

  let timer;
  const schedule = (delay = 250) => {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  };

  /** Like any file: the Explorer expands to the reviewed file and selects it. */
  let revealed = '';
  const revealInExplorer = async (ed) => {
    if (!ed || ed.document.uri.scheme !== REVIEW) {
      revealed = '';
      return;
    }
    const file = fileOfReview(ed.document.uri);
    if (!file || revealed === norm(file)) return;
    revealed = norm(file);
    if (vscode.workspace.getConfiguration('explorer').get('autoReveal') === false) return;
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  };

  /** Opening a changed file shows its review (old lines above new ones) instead. */
  const redirecting = new Set();
  const redirectToReview = async (ed) => {
    if (!ed || !reviewEnabled() || ed.document.uri.scheme !== 'file' || ed.document.isDirty) return;
    const key = norm(ed.document.uri.fsPath);
    const entry = entries.get(key);
    if (!entry || editing.has(key) || redirecting.has(key)) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    // only plain editors (not the file shown inside a diff editor)
    if (!tab || !(tab.input instanceof vscode.TabInputText) || norm(tab.input.uri.fsPath) !== key) return;
    redirecting.add(key);
    try {
      await openFile(entry, false, tab.group.viewColumn);
      await closeTab(tab);
    } finally {
      redirecting.delete(key);
    }
  };

  /** Review tabs of files that were fully kept/undone: close them, move on to the next file. */
  let lastOrder = [];
  const closeResolvedReviews = async () => {
    let moveOn = null;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== REVIEW) continue;
        const file = fileOfReview(input.uri);
        if (entries.has(norm(file))) continue;
        if (tab.isActive && group.isActive) moveOn = { file, viewColumn: group.viewColumn };
        await closeTab(tab);
      }
    }
    if (!moveOn) return;
    const at = lastOrder.indexOf(norm(moveOn.file));
    const after = [...lastOrder.slice(at + 1), ...lastOrder.slice(0, at)].map((k) => entries.get(k)).find(Boolean);
    if (after) await withTimeout(openFile(after, false, moveOn.viewColumn), 5000, 'opening the next file');
    else if (fs.existsSync(moveOn.file)) {
      await withTimeout(vscode.window.showTextDocument(vscode.Uri.file(moveOn.file), { viewColumn: moveOn.viewColumn, preview: false }), 5000, 'opening the file');
    }
  };

  const doRefresh = async () => {
    await scan();
    for (const key of [...editing]) if (!entries.has(key)) editing.delete(key);
    reviewProvider.refresh();
    await closeResolvedReviews();
    // Already on the file when Claude changes it: show the review right away (old lines included).
    await withTimeout(redirectToReview(vscode.window.activeTextEditor), 5000, 'showing the review').catch((e) => log.warn(String(e)));
    lastOrder = ordered().map((e) => norm(e.file));
    provider.refresh();
    lenses.refresh();
    decorations.refresh();
    const count = entries.size;
    view.badge = count ? { value: count, tooltip: `${plural(count, 'file')} changed by Claude` } : undefined;
    updateBar();
    vscode.window.visibleTextEditors.forEach(decorate);

    let retry = false;
    for (const { uri, stamp } of staleDocs) {
      const prev = reloaded.get(uri.fsPath);
      const tries = prev && prev.stamp === stamp ? prev.tries : 0;
      if (tries >= 4) continue; // give up on this disk state (e.g. undecodable file)
      reloaded.set(uri.fsPath, { stamp, tries: tries + 1 });
      log.info(`stale buffer, reloading from disk (try ${tries + 1}): ${uri.fsPath}`);
      vscode.commands.executeCommand('workbench.action.files.revert', uri).then(undefined, (e) => {
        log.warn(`reload failed: ${e && e.message}`);
      });
      retry = true;
    }
    if (retry) schedule(800);

    const keys = new Set(entries.keys());
    if (!firstLoad && config().get('autoOpen')) {
      const fresh = ordered().find((e) => e.exists && !seen.has(norm(e.file)));
      if (fresh) await openFile(fresh, true);
    }
    seen = keys;
    firstLoad = false;
  };

  let queue = Promise.resolve();
  refresh = () => {
    queue = queue.then(() => withTimeout(doRefresh(), 20000, 'refresh')).catch((e) => log.error(String((e && e.stack) || e)));
    return queue;
  };

  // ---- change detection: Claude activity + workspace scan
  let wasActive = false;
  let lastScan = 0;
  let scanEvery = 1000;
  const detect = async () => {
    const folders = folderPaths();
    if (!folders.length) return;
    const last = await activity.last(folders);
    const active = last > 0 && Date.now() - last < ACTIVE_MS;
    const due = Date.now() - lastScan > (active ? scanEvery : IDLE_SCAN_MS);
    if (active === wasActive && !due && tracker.ready) return;

    // When Claude starts working, first absorb what changed before (the user's own work).
    const attribute = active && wasActive;
    if (active !== wasActive) log.info(active ? 'Claude is working' : 'Claude is idle');
    wasActive = active;
    const t0 = Date.now();
    const made = await tracker.sync(folders, attribute, (key) => trackedFiles.has(key), async (file, before) => {
      log.info(`changed by Claude: ${file}${before === null ? ' (new)' : ''}`);
      await writeSnapshot(file, before, 'claude');
    });
    lastScan = Date.now();
    scanEvery = Math.max(1000, (lastScan - t0) * 4); // stay light on big or slow (/mnt/c) projects
    if (tracker.truncated) log.warn('workspace too large: only the first 20000 files are tracked');
    if (made) await refresh();
  };

  // One loop for everything: detect changes, then refresh when pending files changed.
  let lastPrint = '';
  let polling = false;
  let pollStarted = 0;
  const poller = setInterval(async () => {
    if (polling && Date.now() - pollStarted < 60000) return;
    if (polling) log.warn('previous check still running after 60 s, starting a new one');
    polling = true;
    pollStarted = Date.now();
    try {
      await withTimeout(detect(), 30000, 'change detection');
      const print = await fingerprint();
      if (print !== lastPrint) {
        lastPrint = print;
        await refresh();
      }
    } catch (e) {
      log.error(String((e && e.stack) || e));
    } finally {
      polling = false;
    }
  }, 700);

  // The user's own saves are never Claude's changes.
  const typed = new Set();
  const onUserSave = (doc) => {
    if (doc.uri.scheme === 'file' && typed.has(norm(doc.uri.fsPath))) tracker.expect(doc.uri.fsPath, doc.getText());
  };

  const commands = {
    'claudeDiff.refresh': refresh,
    'claudeDiff.openFile': (arg) => {
      const entry = entryFromArg(arg);
      return entry && openFile(entry);
    },
    'claudeDiff.openDiff': (arg) => {
      const entry = entryFromArg(arg);
      return entry && openDiff(entry);
    },
    'claudeDiff.keepFile': (arg) => fileAction(arg, 'keep'),
    'claudeDiff.undoFile': (arg) => fileAction(arg, 'undo'),
    'claudeDiff.keepHunk': (file, sig) => keepHunk(file, sig),
    'claudeDiff.undoHunk': (file, sig) => undoHunk(file, sig),
    'claudeDiff.keepAll': () => bulkAction('keep'),
    'claudeDiff.undoAll': () => bulkAction('undo'),
    'claudeDiff.nextFile': () => goToFile(1),
    'claudeDiff.prevFile': () => goToFile(-1),
    'claudeDiff.restoreLastUndo': () => restoreLastUndo(),
    'claudeDiff.editFile': (arg) => editFile(arg),
    'claudeDiff.reviewFile': (arg) => {
      const entry = entryFromArg(arg);
      if (!entry) return;
      editing.delete(norm(entry.file));
      return openFile(entry);
    },
    'claudeDiff.pickFile': async () => {
      const list = ordered();
      if (!list.length) return goToFile(1);
      const pick = await vscode.window.showQuickPick(
        list.map((e) => {
          const rel = vscode.workspace.asRelativePath(e.file, false);
          return {
            label: `$(file) ${path.basename(e.file)}`,
            description: [path.dirname(rel) === '.' ? '' : path.dirname(rel), e.isNew ? 'new' : e.deleted ? 'deleted' : `+${e.added} −${e.removed}`]
              .filter(Boolean)
              .join(' · '),
            entry: e,
          };
        }),
        { title: 'Files changed by Claude', placeHolder: 'Open a file to review (nothing is kept or undone)' }
      );
      if (pick) await openFile(pick.entry);
    },
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args) =>
        Promise.resolve(fn(...args)).catch((e) => {
          log.error(String((e && e.stack) || e));
          vscode.window.showErrorMessage(`Claude Diff: ${e.message}`);
        })
      )
    );
  }

  context.subscriptions.push(
    view,
    addedType,
    deletionType,
    oldType,
    newType,
    numberType,
    { dispose: () => clearTimeout(timer) },
    { dispose: () => clearTimeout(restoreTimer) },
    { dispose: () => clearInterval(poller) },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BeforeContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW, reviewProvider),
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: REVIEW }], lenses),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new RemovedHover()),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeDiff.showExplorerDot')) decorations.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      tracker.ready = false;
      schedule();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme === REVIEW) {
        vscode.window.visibleTextEditors.filter((ed) => ed.document === e.document).forEach(decorate);
        return;
      }
      if (e.document.uri.scheme !== 'file') return;
      const key = norm(e.document.uri.fsPath);
      if (e.contentChanges.length && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === e.document) {
        typed.add(key);
      }
      if (trackedFiles.has(key)) schedule(300);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => onUserSave(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      onUserSave(doc);
      typed.delete(norm(doc.uri.fsPath));
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === REVIEW) {
        // Old and new lines are interleaved: never let a language server "validate" that mix.
        const plain = config().get('reviewPlainTextLanguages', []);
        if (doc.languageId !== 'plaintext' && plain.includes(doc.languageId)) {
          Promise.resolve(vscode.languages.setTextDocumentLanguage(doc, 'plaintext')).then(undefined, (e) =>
            log.warn(`could not switch the review view to plain text: ${e && e.message}`)
          );
        }
        return;
      }
      if (trackedFiles.has(norm(doc.uri.fsPath))) schedule(50);
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      revealInExplorer(ed).catch(() => {});
      updateBar();
      lenses.refresh();
      redirectToReview(ed).catch((e) => log.error(String((e && e.stack) || e)));
    })
  );

  await refresh();

  // Older versions installed a Claude Code hook: remove it, nothing needs to be installed now.
  try {
    const cleaned = await removeLegacyHooks();
    if (cleaned.length) log.info(`removed the old Claude Code hook from ${cleaned.join(', ')}`);
    await removeLegacyDirs();
  } catch (e) {
    log.warn(`legacy cleanup failed: ${e.message}`);
  }

  // Small surface used by the integration tests.
  return {
    _entries: () => [...entries.values()],
    _refresh: refresh,
    _decorations: decorations,
    _hasUndo: () => !!lastUndo,
    _review: (file) => {
      const e = entries.get(norm(file));
      return e && buildReview(e);
    },
    _ready: () => tracker.ready,
    _bar: () =>
      Object.fromEntries(Object.entries(bar).map(([k, v]) => [k, { text: v.text, visible: !!v.visibleNow }])),
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
