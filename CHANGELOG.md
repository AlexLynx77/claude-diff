# Changelog

## 0.8.9

- Fix: a Keep on one block could be lost when clicked right after another (before the review had redrawn): the second click rebuilt the "before" from the old state and put the first block back "to review". Keep, Undo, Keep All, Undo All and Restore now run one after the other, each on a fresh scan, and never overwrite each other. The same went for Undo file right after a Keep on a block (it undid that block too).
- Fix: a block kept while the extension was reading the file could stay "to review" until the window was reloaded (stale cache of the "before"). The cache now checks that the file did not change.
- A Keep / Undo button now remembers what its change says, not only where it is. After another change is kept or undone and the lines move, it still acts on its own block; if Claude changed that block again since the button was drawn, nothing is kept or undone (a message says so) instead of accepting lines you were never shown.
- Tests: `test/hunks.fuzz.js` (40 000 stale clicks, with and without duplicated lines) and end-to-end tests of fast Keep / Undo clicks in any order.

## 0.8.8

- A `git commit` no longer takes files out of the review by default: a commit is not a review, and Claude may commit by itself. The behaviour of 0.8.6 and 0.8.7 is now the setting `claudeDiff.clearReviewOnCommit` (default `false`).
- With that setting on: files that git ignores (build output such as `public/`, screenshots...) are cleared by a commit too, since a commit can never hold them; secret-looking files (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`) still stay to review.
- End-to-end tests: a commit leaves the review alone by default; with the setting on, an ignored file and a secret around a commit.

## 0.8.7

- Fix: a change committed right after being made stayed "to review". When Claude edits a file and commits in the same breath, the extension noticed the edit only after the commit, and nothing compared it with that commit anymore. A change noticed within a minute of a commit is now checked against it, like the files already waiting.
- Fix: a change committed while the window was closed or reloaded stayed "to review" forever. When a repository is first looked at, pending files that are exactly what HEAD holds are kept.
- End-to-end test for an edit committed at once.

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
