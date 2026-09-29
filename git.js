'use strict';
// Recognises the file changes made by git itself (checkout, merge, pull, rebase, reset...), so that
// they are never mistaken for Claude's: the working tree changes under the extension's feet, and
// "Claude is active" is only a guess. Nothing to configure; without git, nothing changes.
//
// Signals (all cheap: a few stat calls per poll):
// - <gitdir>/logs/HEAD grows whenever HEAD moves: the reflog line tells which operation it was.
//   A plain `commit` does not touch the working tree, everything else does.
// - <gitdir>/MERGE_HEAD appears while a merge (or a pull) is stopped on conflicts.
// - <gitdir>/index.lock exists while git is writing: the working tree is half done, wait.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** A lock older than this is a leftover of a crashed git, not an operation in progress. */
const LOCK_MAX_AGE = 60 * 1000;
/** How long a file written by git waits to be seen by a scan before it is forgotten. */
const FILES_TTL = 15 * 1000;
/** When the exact list of files is unknown, everything that changes in this delay is git's. */
const ALL_TTL = 4 * 1000;
const RESOLVE_RETRY = 60 * 1000;

/** Runs git, resolves to its stdout, or null when it fails (no git, not a repo, unknown revision). */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15000, windowsHide: true },
      (err, out) => resolve(err ? null : out)
    );
  });
}

/** Content of `rel` (a path relative to the repository root) at revision `rev`, or null. */
const show = (top, rev, rel) => git(top, ['show', `${rev}:${rel}`]);

const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]*\t(.*)$/;
const ZERO = /^0+$/;

class GitWatch {
  constructor() {
    /** gitDir -> {top, gitDir, size, merge} */
    this.repos = new Map();
    this.resolvedAt = new Map(); // folder -> time of the last attempt
    /** norm(path) -> expiry: files git wrote that no scan has seen yet */
    this.written = new Map();
    this.allUntil = 0;
  }

  /** True when the workspace is (partly) a git repository. */
  get active() {
    return this.repos.size > 0;
  }

  async resolve(folders) {
    for (const folder of folders) {
      // a folder that is not a repository is looked at again from time to time (git init, clone...)
      if (Date.now() - (this.resolvedAt.get(folder) || -Infinity) < RESOLVE_RETRY) continue;
      const out = await git(folder, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
      const [gitDir, top] = out ? out.split('\n').map((s) => path.normalize(s.trim())) : [];
      if (gitDir && top) {
        this.resolvedAt.set(folder, Infinity); // found: never looked up again
        if (!this.repos.has(gitDir)) this.repos.set(gitDir, { top, gitDir, size: undefined, merge: undefined });
      } else {
        this.resolvedAt.set(folder, Date.now());
      }
    }
  }

  async statSize(file) {
    try {
      return (await fs.promises.stat(file)).size;
    } catch {
      return undefined;
    }
  }

  async readFrom(file, from, to) {
    const h = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      await h.read(buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally {
      await h.close();
    }
  }

  async locked(repo) {
    for (const name of ['index.lock', 'HEAD.lock']) {
      try {
        const st = await fs.promises.stat(path.join(repo.gitDir, name));
        if (Date.now() - st.mtimeMs < LOCK_MAX_AGE) return true;
      } catch {
        // no lock
      }
    }
    return false;
  }

  /** Files that differ between two revisions, as norm(absolute path) (null: could not tell). */
  async changedFiles(repo, from, to) {
    const out = await git(repo.top, ['diff', '--name-only', '--no-renames', '-z', from, to]);
    if (out === null) return null;
    return new Set(out.split('\0').filter(Boolean).map((rel) => norm(path.join(repo.top, rel))));
  }

  /**
   * Looks for git operations since the last call.
   * @returns {Promise<{busy: boolean, fresh: {top: string, old: string | null, new: string | null, files: Set<string> | null, rebase: boolean}[], committed: {top: string, rev: string}[]}>}
   *   busy: git is writing the working tree right now; fresh: operations that just finished;
   *   committed: repositories where a commit was just made, and HEAD after it.
   */
  async poll(folders) {
    const fresh = [];
    const committed = [];
    let busy = false;
    try {
      await this.resolve(folders);
      for (const repo of this.repos.values()) {
        if (await this.locked(repo)) busy = true;

        // HEAD moved: checkout, merge, pull, rebase, reset, commit...
        const log = path.join(repo.gitDir, 'logs', 'HEAD');
        const size = await this.statSize(log);
        if (size !== undefined && repo.size !== undefined && size > repo.size) {
          const text = await this.readFrom(log, repo.size, size);
          const lines = text
            .split('\n')
            .map((l) => REFLOG_LINE.exec(l))
            .filter(Boolean)
            .map((m) => ({ old: m[1], new: m[2], msg: m[3] }));
          // a commit only records the files, it never writes them
          const writes = lines.filter((l) => !/^commit\b/.test(l.msg));
          if (writes.length < lines.length) committed.push({ top: repo.top, rev: lines[lines.length - 1].new });
          if (writes.length) {
            const from = writes[0].old;
            const to = writes[writes.length - 1].new;
            const known = !ZERO.test(from);
            fresh.push({ top: repo.top, old: known ? from : null, new: to, files: known ? await this.changedFiles(repo, from, to) : null, rebase: known });
          }
        }
        // First look at this repository: commits made while nobody was watching (window closed or
        // reloaded) may hold files that are still waiting for review.
        if (size !== undefined && repo.size === undefined) committed.push({ top: repo.top, rev: 'HEAD' });
        repo.size = size;

        // A merge stopped on conflicts: HEAD did not move, the working tree did.
        let merge = '';
        try {
          merge = (await fs.promises.readFile(path.join(repo.gitDir, 'MERGE_HEAD'), 'utf8')).trim();
        } catch {
          // no merge in progress
        }
        if (merge && merge !== repo.merge) {
          fresh.push({ top: repo.top, old: 'HEAD', new: merge, files: await this.changedFiles(repo, 'HEAD', merge), rebase: false });
        }
        repo.merge = merge;
      }
    } catch {
      // never let git break the detection of Claude's own changes
    }
    const now = Date.now();
    for (const [f, until] of this.written) if (until < now) this.written.delete(f);
    for (const op of fresh) {
      if (op.files) for (const f of op.files) this.written.set(f, now + FILES_TTL);
      else this.allUntil = now + ALL_TTL;
    }
    return { busy, fresh, committed };
  }

  /** True (once) when git wrote this file since the last scan saw it. */
  take(key) {
    const now = Date.now();
    if (now < this.allUntil) return true;
    const until = this.written.get(key);
    if (until === undefined) return false;
    this.written.delete(key);
    return until > now;
  }
}

module.exports = { GitWatch, git, show };
