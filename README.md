# Claude Diff

See, keep or undo the file changes made by [Claude Code](https://claude.com/claude-code), right in the editor — like Copilot's edit review. Works in VS Code, Antigravity and other forks, locally or over WSL/SSH. **Nothing to install or configure** besides the extension itself.

> **Unofficial project.** Claude Diff is an independent, community-made extension for Claude Code in VS Code. It is not made, endorsed or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, used here only to say what the extension works with.

## What you get

- A **dot (●)** next to every file Claude changed, in the Explorer and on editor tabs; folders containing changed files are tinted.
- A **review bar** in the status bar as soon as Claude changes something, updated live:
  `‹  Claude · file 2/5  ›   ✓ Keep   ↶ Undo   ✓✓ Keep All   ↶ Undo All`
  Click the file counter to jump to any changed file.
- **Opening a changed file shows its review**: the whole file with syntax highlighting, where every line or block Claude removed or replaced is shown **greyed out right above** the new code (in green). Above each block: `Keep` · `Undo`. At the top: `Previous` · `Next` · `Keep file` · `Undo file` · `Edit file`.
  - The review is read-only; `Edit file` opens the file itself (changed lines highlighted, `Keep`/`Undo` above each change, old text on hover, and a `Review` button to go back).
  - If the file is already on screen when Claude changes it, its review appears right away.
  - When the last block of a file is kept or undone, its review closes and the next changed file opens.
  - The review tab has the file's own name and icon, and the Explorer expands to the file and selects it, like for any file.
- **Nothing is ever kept or undone by default.** Opening, leaving or closing a file, or moving to the next/previous one, changes nothing. A file leaves the review only when you keep or undo it (or all changes).
- **No notifications, no confirmation dialogs.** An undo can be reverted with `Restore`, shown in the review bar for a minute (also `Claude Diff: Restore Last Undo`).
- Pending reviews survive a window reload.

## How it works

- Claude Code writes a transcript (`~/.claude/projects/…/*.jsonl`) while it works. When that transcript is active for the open folder, Claude is considered to be working.
- The extension keeps the last known content of the workspace's text files. Any file that changes while Claude works — edit tool, shell command, script, new or deleted file, git-ignored files like `.env` — becomes a change to review, compared with its content from just before.
- Your own edits saved in the editor, and changes made while Claude is idle, are not attributed to Claude.

## Privacy

Everything stays on your machine; the extension makes no network request.

- It only looks at the *modification time* of Claude Code's transcripts (`~/.claude/projects/…/*.jsonl`, or `$CLAUDE_CONFIG_DIR/projects`) to know when Claude is working. It never reads their content.
- To be able to show and undo a change, it keeps a copy of each file's content from just before Claude changed it, in VS Code's per-workspace storage folder (outside your project). **This includes git-ignored files such as `.env`**, stored as plain text there, until you keep or undo the change. Add folders to `claudeDiff.exclude` to keep them out of tracking.
- It never writes to your project except when you press Undo / Restore (and, once, to remove the hook installed by versions ≤ 0.5).

## Settings

- `claudeDiff.exclude`: folder names never tracked (default: `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `target`, `__pycache__`, `.venv`, ...).
- `claudeDiff.reviewView` (default `true`): open changed files in the review view. Turn it off to always open the files themselves.
- `claudeDiff.reviewPlainTextLanguages` (default `json`, `jsonc`, `css`, `scss`, `less`): languages whose review view is plain text. VS Code's JSON and CSS servers validate every document, including the review view where old and new lines are mixed, and would report syntax errors that are not in the real file. Remove a language from the list to get its highlighting back.
- `claudeDiff.showExplorerDot` (default `true`).
- `claudeDiff.autoOpen` (default `false`): open a file (without stealing focus) the first time Claude changes it.
- `claudeDiff.clearReviewOnCommit` (default `false`): by default a `git commit` does not change the review: a commit is not a review, and Claude may commit by itself. Turn it on to have a commit take out of the review the files it holds exactly (modified, created or deleted) and the files git ignores; secret-looking files (`.env*`, `*.pem`, `*.key`...) always stay. Switching branch never counts as Claude's changes either way.

## Install

1. Download `claude-diff-<version>.vsix` from the [latest release](https://github.com/AlexLynx77/claude-diff/releases/latest) (or build it yourself: `npm run package`).
2. In the IDE (connected to WSL/SSH if you work there): Extensions → `...` → **Install from VSIX...** → the `.vsix`, then reload the window.

To update, install the new `.vsix` the same way and reload the window.

Versions ≤ 0.5 installed a Claude Code hook; it is removed automatically.

## Limits

- Changes made outside the editor by you or another tool *while Claude is working* (up to 2 minutes after its last activity) are attributed to Claude.
- Files larger than 2 MB, binary files and folders listed in `claudeDiff.exclude` are not tracked; at most 20,000 files per workspace.
- Extensions cannot insert lines into a regular editor (Copilot is built into VS Code), so the old lines are shown in the separate, read-only review view. Its line numbers are those of the real file (old lines have none).
- The review bar lives in the status bar: extensions cannot draw a floating toolbar over the editor like the built-in Copilot one.

## Development

- Open the folder in VS Code and press F5 (*Run Extension*) to try it in a second window.
- `npm run test:unit`: randomized test of the diff / keep / undo logic (Node.js only).
- `npm run test:e2e`: starts a throw-away VS Code with the extension, fakes a Claude Code session, edits files like Claude would and checks the review view, Keep and Undo. It uses temporary folders only. Set `CODE_PATH` if VS Code is not found; close other VS Code windows first if the launch is blocked.
- `npm test` runs both. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
