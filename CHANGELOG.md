# Changelog

## 0.8.6

- A `git commit` now keeps what it commits: a file waiting for review that is exactly what the commit holds (modified, created or deleted) is no longer to review. Files with anything not committed yet, and git-ignored files, stay. Before, a committed change stayed "to review", and after a checkout to another branch it could show that branch's differences as Claude's.
- End-to-end tests for partial commits, `commit -a` and deleted files.

## 0.8.5

- Fix: changes you had already kept came back "to review" after a `git checkout`, `merge`, `pull`, `rebase` or `reset`. Claude is considered active for 2 minutes after its last message, and every file that changed in that time was assumed to be Claude's, including the files git itself rewrote when you switched branch. Claude Diff now recognises git's own writes (through the HEAD reflog, `MERGE_HEAD` and git's lock files) and never counts them as Claude's changes. A plain `git commit` is not affected, and Claude's own edits, even on a file git has just written, are still detected.
- Fix: a file still waiting for review no longer shows what came from git as Claude's. After a checkout or pull, its "before" follows the new HEAD, so only Claude's own lines stay to review.
- Changes are now confirmed about 1.5 s after being seen in a git repository, to leave git the time to finish.
- End-to-end tests for checkout, merge and checkout with local changes while Claude is active.

## 0.8.4

- Fix: the review view no longer shows syntax errors that are not in the real file. It mixes old and new lines, and VS Code's JSON and CSS language servers validated it anyway. Review views of `json`, `jsonc`, `css`, `scss` and `less` are now plain text; the list is configurable with `claudeDiff.reviewPlainTextLanguages`.
- Add automated tests (`npm test`): a randomized test of the diff / keep / undo logic and an end-to-end test that runs the extension inside a real VS Code.
- Documentation: unofficial-project notice, privacy notes, contributing guide.

## 0.8.3

- Previous version (no changelog kept before this release).
