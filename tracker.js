'use strict';
// Detects the files Claude Code changes, without any hook:
// - Activity: Claude Code appends to a transcript (~/.claude/projects/<encoded cwd>/<session>.jsonl)
//   all along a conversation, so a recently written transcript means Claude is working here.
// - Tracker: keeps the last known content of every text file of the workspace. When a file
//   changes while Claude is active, its previous content becomes the baseline to review.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_CACHE_CHARS = 200e6;

const ci = process.platform === 'win32';
const norm = (p) => (ci ? p.toLowerCase() : p);
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

class Activity {
  constructor() {
    this.dirs = [];
    this.dirsAt = 0;
    this.key = '';
  }

  static projectsDir() {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'projects');
  }

  /** Time (ms) of the latest transcript write of a Claude Code session in or around `folders`. */
  async last(folders) {
    const root = Activity.projectsDir();
    const key = folders.join('|');
    if (Date.now() - this.dirsAt > 5000 || key !== this.key) {
      this.dirsAt = Date.now();
      this.key = key;
      const wanted = folders.map((f) => norm(encode(f)));
      try {
        this.dirs = (await fs.promises.readdir(root))
          .filter((d) => {
            const n = norm(d);
            // same folder, a subfolder (Claude started in ./client) or a parent folder
            return wanted.some((w) => n === w || n.startsWith(w + '-') || w.startsWith(n + '-'));
          })
          .map((d) => path.join(root, d));
      } catch {
        this.dirs = [];
      }
    }
    let latest = 0;
    for (const dir of this.dirs) {
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        try {
          const m = (await fs.promises.stat(path.join(dir, n))).mtimeMs;
          if (m > latest) latest = m;
        } catch {
          // removed meanwhile
        }
      }
    }
    return latest;
  }
}

class Tracker {
  /** @param {{exclude: () => string[], skip: (p: string) => boolean}} opts */
  constructor(opts) {
    this.opts = opts;
    /** norm(path) -> {path, mtime, size, content: string | undefined (not trackable)} */
    this.cache = new Map();
    this.chars = 0;
    this.ready = false;
    /** norm(path) -> {content, until}: a write made by the user or the extension, not by Claude */
    this.expected = new Map();
    this.truncated = false;
  }

  /**
   * `file` is about to be written with `content` (null = deleted) by the user or the extension.
   * Seeing exactly that is not Claude's change; any other content still is.
   */
  expect(file, content, ms = 10000) {
    this.expected.set(norm(file), { content, until: Date.now() + ms });
  }

  isExpected(key, content) {
    const e = this.expected.get(key);
    if (!e) return false;
    if (e.until < Date.now()) {
      this.expected.delete(key);
      return false;
    }
    const strip = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
    if (strip(e.content) !== strip(content)) return false;
    this.expected.delete(key);
    return true;
  }

  async walk(folders) {
    const files = new Map();
    const failed = [];
    const exclude = new Set(this.opts.exclude());
    let truncated = false;
    const visit = async (dir) => {
      let items;
      try {
        items = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        failed.push(dir);
        return;
      }
      const subdirs = [];
      await Promise.all(
        items.map(async (d) => {
          const p = path.join(dir, d.name);
          if (d.isDirectory()) {
            if (!exclude.has(d.name) && !this.opts.skip(p)) subdirs.push(p);
          } else if (d.isFile()) {
            if (files.size >= MAX_FILES) {
              truncated = true;
              return;
            }
            try {
              const st = await fs.promises.stat(p);
              files.set(norm(p), { path: p, mtime: st.mtimeMs, size: st.size });
            } catch {
              failed.push(p);
            }
          }
        })
      );
      for (const s of subdirs) await visit(s);
    };
    for (const f of folders) await visit(f);
    return { files, failed, truncated };
  }

  async readText(file, size) {
    if (size > MAX_BYTES || this.chars > MAX_CACHE_CHARS) return undefined;
    try {
      const buf = await fs.promises.readFile(file);
      return buf.includes(0) ? undefined : buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  set(key, st, content) {
    const old = this.cache.get(key);
    if (old && old.content) this.chars -= old.content.length;
    if (content) this.chars += content.length;
    this.cache.set(key, { path: st.path, mtime: st.mtime, size: st.size, content });
  }

  drop(key) {
    const old = this.cache.get(key);
    if (old && old.content) this.chars -= old.content.length;
    this.cache.delete(key);
  }

  /** Re-reads one file into the cache (after the extension or the user wrote it). */
  async refresh(file) {
    const key = norm(file);
    try {
      const st = await fs.promises.stat(file);
      this.set(key, { path: file, mtime: st.mtimeMs, size: st.size }, await this.readText(file, st.size));
    } catch {
      this.drop(key);
    }
  }

  /**
   * Compares the workspace with the cache. When `attribute` is true, every change not made by
   * the user/extension is reported to `onChange(file, before)` (before = null for a new file).
   */
  async sync(folders, attribute, isPending, onChange) {
    const { files, failed, truncated } = await this.walk(folders);
    this.truncated = truncated;
    let changes = 0;
    for (const [key, st] of files) {
      const rec = this.cache.get(key);
      if (rec && rec.mtime === st.mtime && rec.size === st.size) continue;
      const content = await this.readText(st.path, st.size);
      if (attribute && this.ready && !this.isExpected(key, content) && !isPending(key)) {
        if (!rec) {
          if (content !== undefined) {
            await onChange(st.path, null);
            changes++;
          }
        } else if (rec.content !== undefined && content !== undefined && content !== rec.content) {
          await onChange(st.path, rec.content);
          changes++;
        }
      }
      this.set(key, st, content);
    }
    // Deletions (only when the walk saw everything: a failed readdir is not a deletion).
    if (!truncated) {
      const unsure = failed.map((f) => norm(f));
      for (const [key, rec] of [...this.cache]) {
        if (files.has(key)) continue;
        if (unsure.some((u) => key === u || key.startsWith(u + path.sep))) continue;
        if (attribute && this.ready && !this.isExpected(key, null) && !isPending(key) && rec.content !== undefined) {
          await onChange(rec.path, rec.content);
          changes++;
        }
        this.drop(key);
      }
    }
    this.ready = true;
    return changes;
  }
}

module.exports = { Activity, Tracker, encode, norm };
