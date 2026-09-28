# Changelog

## 0.8.4

- Fix: the review view no longer shows syntax errors that are not in the real file. It mixes old and new lines, and VS Code's JSON and CSS language servers validated it anyway. Review views of `json`, `jsonc`, `css`, `scss` and `less` are now plain text; the list is configurable with `claudeDiff.reviewPlainTextLanguages`.
- Add automated tests (`npm test`): a randomized test of the diff / keep / undo logic and an end-to-end test that runs the extension inside a real VS Code.
- Documentation: unofficial-project notice, privacy notes, contributing guide.

## 0.8.3

- Previous version (no changelog kept before this release).
