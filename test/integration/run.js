// Runs the integration tests (test/integration/suite.js) inside a real VS Code.
// Run with: npm run test:integration
//
// Uses the VS Code already installed on this machine (no download): set
// VSCODE_BIN to its executable if it is not in the default macOS location.
// A throwaway user-data and extensions folder is used, so your settings and
// extensions are not touched, and the test files are copies of examples/ in a
// temporary folder.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

function vscodeBinary() {
  if (process.env.VSCODE_BIN) return process.env.VSCODE_BIN;
  const candidates = [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '/usr/share/code/code',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('VS Code not found; set VSCODE_BIN to its executable.');
  return found;
}

// Short paths: VS Code's IPC socket path must stay under ~100 characters.
const tmp = fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'nh-it-'));
const workspace = path.join(tmp, 'ws');
fs.mkdirSync(workspace);
for (const f of ['sample.ipynb', 'sample.md', 'showcase.ipynb', path.join('.vscode', 'notebook-headings.json')]) {
  fs.mkdirSync(path.dirname(path.join(workspace, f)), { recursive: true });
  fs.copyFileSync(path.join(root, 'examples', f), path.join(workspace, f));
}

const args = [
  workspace,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`,
  `--user-data-dir=${path.join(tmp, 'user')}`,
  `--extensions-dir=${path.join(tmp, 'ext')}`,
  '--new-window',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-workspace-trust',
];

const child = spawn(vscodeBinary(), args, { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
child.on('exit', (code) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === null ? 1 : code);
});
