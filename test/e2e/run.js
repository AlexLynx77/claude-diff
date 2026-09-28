'use strict';
// End-to-end test: starts a throw-away VS Code with this extension loaded from the repo
// and runs test/e2e/suite.js in its extension host. Nothing of your own settings, extensions
// or projects is touched (temporary user-data dir, temporary workspace, fake Claude config).
//
//   npm run test:e2e            (set CODE_PATH to the VS Code executable if it is not found)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findCode() {
  if (process.env.CODE_PATH) return process.env.CODE_PATH;
  const candidates = {
    win32: [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    ],
    darwin: ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
    linux: ['/usr/share/code/code', '/usr/lib/code/code', '/opt/visual-studio-code/code'],
  }[process.platform] || [];
  return candidates.find((p) => fs.existsSync(p));
}

const code = findCode();
if (!code) {
  console.error('VS Code not found. Set CODE_PATH to its executable (Code.exe / code).');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-diff-e2e-'));
const dirs = Object.fromEntries(['workspace', 'config', 'user', 'extensions'].map((n) => [n, path.join(tmp, n)]));
Object.values(dirs).forEach((d) => fs.mkdirSync(d));
const out = path.join(tmp, 'result.json');

// The workspace is a git repository, to check that checkout / merge / pull are not taken for Claude.
const gitOk = ['init -q -b main', 'config user.name t', 'config user.email t@t', 'config core.autocrlf false', 'config commit.gpgsign false'].every(
  (a) => spawnSync('git', a.split(' '), { cwd: dirs.workspace, stdio: 'ignore' }).status === 0
);
if (!gitOk) console.log('git not found: the git scenarios are skipped.');

const env = { ...process.env, E2E_OUT: out, CLAUDE_CONFIG_DIR: dirs.config, CLAUDE_DIFF_ACTIVE_MS: '120000', ...(gitOk ? { E2E_GIT: '1' } : {}) };
delete env.ELECTRON_RUN_AS_NODE; // would make VS Code start as a plain Node.js

console.log('Starting VS Code (about a minute)...');
const run = spawnSync(
  code,
  [
    dirs.workspace,
    `--user-data-dir=${dirs.user}`,
    `--extensions-dir=${dirs.extensions}`,
    `--extensionDevelopmentPath=${path.resolve(__dirname, '..', '..')}`,
    `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
  ],
  {
    env,
    stdio: 'ignore',
    timeout: 5 * 60 * 1000,
  }
);

let results = [];
try {
  results = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  console.error(`No result file (VS Code exit code ${run.status}). Is another VS Code window blocking the launch?`);
  process.exit(1);
}
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // VS Code may still hold a handle for a moment
}
process.exit(failed ? 1 : 0);
