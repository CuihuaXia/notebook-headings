// Integration tests: run inside VS Code's extension host by run.js, against
// copies of the example files. They cover what the unit tests cannot: the
// tree, the status bar, marks written to real documents, and output clearing.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (name) => vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, name));

/** Poll until `check()` returns a truthy value (or throw after `ms`). */
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

let api;
const provider = () => api.provider;
const node = (text) => provider().flat.find((n) => n.text === text);

async function openMarkdown(name) {
  const doc = await vscode.workspace.openTextDocument(file(name));
  await vscode.window.showTextDocument(doc);
  await until(() => provider().source && provider().source.doc === doc && provider().flat.length, `${name} in the tree`);
  return doc;
}

async function openNotebook(name) {
  const nb = await vscode.workspace.openNotebookDocument(file(name));
  await vscode.window.showNotebookDocument(nb);
  await until(() => provider().source && provider().source.doc === nb && provider().flat.length, `${name} in the tree`);
  return nb;
}

/** Wait for the debounced rebuild after an edit. */
const rebuilt = () => sleep(600);

const tests = [
  [
    'Markdown: jumping to a heading shows it in the status bar (scroll does not override it)',
    async () => {
      await openMarkdown('sample.md');
      await api.revealHeading(node('Model'));
      await sleep(1500); // past the debounced scroll handling
      assert.match(api.status.text, /Model/);
      await api.revealHeading(node('Check missing values'));
      await sleep(1500);
      assert.match(api.status.text, /Check missing values/);
    },
  ],
  [
    'Markdown: turning the markdown setting off clears the tree',
    async () => {
      await openMarkdown('sample.md');
      const cfg = vscode.workspace.getConfiguration('notebookHeadings');
      await cfg.update('markdown', false, vscode.ConfigurationTarget.Global);
      try {
        await until(() => !provider().source, 'the tree to clear');
      } finally {
        await cfg.update('markdown', undefined, vscode.ConfigurationTarget.Global);
      }
      await until(() => provider().source, 'the tree to come back');
    },
  ],
  [
    'Markdown: marks are saved in .vscode/notebook-headings.json and follow their heading',
    async () => {
      const doc = await openMarkdown('sample.md');
      const marksFile = file(path.join('.vscode', 'notebook-headings.json')).fsPath;
      const readMarksFile = () => JSON.parse(fs.readFileSync(marksFile, 'utf8'));
      // Start without the example marks file (put back at the end).
      const examples = fs.readFileSync(marksFile, 'utf8');
      fs.rmSync(marksFile);
      assert.ok(await api.setMarks([node('Model')], { status: 'todo', star: true }));
      assert.equal(node('Model').status, 'todo');
      assert.equal(node('Model').star, true);
      assert.equal(provider().starGroup.children.length, 1);
      const saved = readMarksFile().marks['sample.md'];
      assert.deepEqual(Object.values(saved), [{ star: true, status: 'todo', text: 'Model' }]);
      // Insert a heading above: the mark stays on "Model".
      const edit = new vscode.WorkspaceEdit();
      const at = doc.getText().split('\n').findIndex((l) => l.startsWith('## Setup'));
      edit.insert(doc.uri, new vscode.Position(at, 0), '## Inserted\n\n');
      await vscode.workspace.applyEdit(edit);
      await rebuilt();
      assert.equal(node('Model').status, 'todo');
      assert.equal(node('Inserted').status, undefined);
      assert.equal(doc.getText().includes('todo'), false, 'the Markdown file itself is not changed by marks');
      await doc.save();
      // Rename the file in VS Code: the marks move to the new name.
      const renamed = file('renamed.md');
      const move = new vscode.WorkspaceEdit();
      move.renameFile(doc.uri, renamed);
      await vscode.workspace.applyEdit(move);
      await until(() => readMarksFile().marks['renamed.md'], 'the marks to follow the rename');
      assert.equal(readMarksFile().marks['sample.md'], undefined);
      // An edit made outside this window (e.g. git pull) shows up.
      const data = readMarksFile();
      data.marks['renamed.md'] = { 0: { status: 'done', text: 'Sample Markdown' } };
      fs.writeFileSync(marksFile, JSON.stringify(data));
      await openMarkdown('renamed.md');
      await until(() => node('Sample Markdown') && node('Sample Markdown').status === 'done', 'the external change');
      assert.equal(node('Model').status, undefined);
      // Clearing the last mark deletes the file.
      await api.setMarks([node('Sample Markdown')], { status: null });
      assert.equal(fs.existsSync(marksFile), false);
      fs.writeFileSync(marksFile, examples);
    },
  ],
  [
    'Notebook: clicking the first of two headings in one cell shows that heading',
    async () => {
      await openNotebook('sample.ipynb');
      const summary = node('Summary');
      assert.equal(summary.pos, node('Means').pos, 'the example has both in one cell');
      await api.revealHeading(summary);
      await sleep(1500);
      assert.match(api.status.text, /Summary/);
      assert.doesNotMatch(api.status.text, /Means/);
    },
  ],
  [
    'Notebook: marks go to the marks file, not the notebook, and follow their heading',
    async () => {
      const nb = await openNotebook('sample.ipynb');
      const marksFile = file(path.join('.vscode', 'notebook-headings.json')).fsPath;
      const cell = nb.cellAt(node('Means').pos);
      const metaBefore = JSON.stringify(cell.metadata);
      assert.ok(await api.setMarks([node('Means')], { status: 'question' }));
      assert.equal(node('Means').status, 'question');
      assert.equal(JSON.stringify(nb.cellAt(node('Means').pos).metadata), metaBefore, 'the notebook is not changed');
      assert.equal(nb.isDirty, false);
      const entry = JSON.parse(fs.readFileSync(marksFile, 'utf8')).marks['sample.ipynb'];
      assert.deepEqual(Object.values(entry), [{ status: 'question', text: 'Means' }]);
      // A heading added above it in the same cell does not move the mark.
      const edit = new vscode.WorkspaceEdit();
      edit.insert(cell.document.uri, new vscode.Position(0, 0), '### Inserted\n\n');
      await vscode.workspace.applyEdit(edit);
      await rebuilt();
      assert.equal(node('Means').status, 'question');
      assert.equal(node('Inserted').status, undefined);
      assert.equal(node('Summary').status, undefined);
      await api.setMarks([node('Means')], { status: null });
    },
  ],
  [
    'Notebook: marks saved in cell metadata by 1.5 still show, and move to the file when their cell changes',
    async () => {
      const nb = await openNotebook('showcase.ipynb');
      const marksFile = file(path.join('.vscode', 'notebook-headings.json')).fsPath;
      const legacyMeta = (cell) => (cell.metadata.metadata || (cell.metadata.custom || {}).metadata || {}).notebook_headings;
      const cellOf = (text) => nb.cellAt(node(text).pos);
      const readEntry = () => JSON.parse(fs.readFileSync(marksFile, 'utf8')).marks['showcase.ipynb'];
      const before = Object.keys(readEntry()).length;
      // Write two headings' marks into their cells the way 1.5 did.
      const old = new vscode.WorkspaceEdit();
      old.set(nb.uri, [
        ['By year built', { 0: { status: 'todo' } }],
        ['Feature importance', { 0: { star: true } }],
      ].map(([text, marks]) => {
        const cell = cellOf(text);
        const md = JSON.parse(JSON.stringify(cell.metadata));
        const holder = md.custom ? md.custom : md;
        holder.metadata = { ...(holder.metadata || {}), notebook_headings: marks };
        return vscode.NotebookEdit.updateCellMetadata(cell.index, md);
      }));
      await vscode.workspace.applyEdit(old);
      await rebuilt();
      assert.equal(node('By year built').status, 'todo', '1.5 marks still show');
      assert.equal(node('Feature importance').star, true);
      // Changing one mark moves that cell's marks to the file and out of the cell.
      assert.ok(await api.setMarks([node('By year built')], { status: 'done' }));
      assert.equal(legacyMeta(cellOf('By year built')), undefined);
      assert.ok(legacyMeta(cellOf('Feature importance')), 'other cells are left alone');
      const entry = readEntry();
      assert.equal(Object.keys(entry).length, before + 1);
      assert.ok(Object.values(entry).some((x) => x.text === 'By year built' && x.status === 'done'));
      assert.equal(node('By year built').status, 'done');
      assert.equal(node('Feature importance').star, true, 'still read from its cell');
    },
  ],
  [
    'Notebook: Show Marked Headings shows every marked heading and its parents',
    async () => {
      await openNotebook('showcase.ipynb');
      await vscode.commands.executeCommand('notebookHeadings.showMarked');
      const flat = provider().flat;
      const marked = flat.filter((n) => n.star || n.status);
      assert.ok(marked.some((n) => n.status === 'done'), 'finished headings are shown too');
      assert.ok(marked.every((n) => n.visible));
      assert.ok(flat.filter((n) => n.visible).every((n) => n.star || n.status || n.children.some((c) => c.visible)));
      assert.equal(provider().markedCount, marked.length);
      await vscode.commands.executeCommand('notebookHeadings.clearFilter');
      assert.ok(provider().flat.every((n) => n.visible));
      const draft = flat.find((n) => n.autoStatus);
      assert.ok(draft, 'showcase.ipynb has a heading with ???');
      assert.equal(draft.status, 'question', '??? means To check');
    },
  ],
  [
    'Notebook: Clear Section Outputs clears only that section and keeps the code',
    async () => {
      const nb = await openNotebook('showcase.ipynb');
      const exploration = node('Exploration');
      const inside = [];
      for (let i = exploration.pos; i < exploration.pos + exploration.size; i++) inside.push(nb.cellAt(i));
      const code = inside.map((c) => c.document.getText());
      const outsideBefore = nb.getCells().filter((c) => !inside.includes(c) && c.outputs.length).length;
      assert.ok(inside.some((c) => c.outputs.length), 'the section has outputs to clear');
      await api.clearOutputs(exploration, undefined, { confirm: false });
      const after = [];
      for (let i = exploration.pos; i < exploration.pos + exploration.size; i++) after.push(nb.cellAt(i));
      assert.ok(after.every((c) => c.outputs.length === 0));
      assert.deepEqual(after.map((c) => c.document.getText()), code);
      assert.equal(nb.getCells().filter((c) => c.outputs.length).length, outsideBefore);
      // Cmd+Z restores them (checked by hand: the `undo` command does not reach
      // the notebook's undo stack from the extension host).
    },
  ],
  [
    'Fix .gitignore lets git keep only the marks file, and changes nothing when it cannot help',
    async () => {
      const { execFileSync } = require('node:child_process');
      const ignored = (cwd, p) => {
        try {
          execFileSync('git', ['check-ignore', '-q', p], { cwd });
          return true;
        } catch {
          return false;
        }
      };
      const tmp = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'nh-git-'));
      try {
        // A project whose .gitignore ignores the whole .vscode folder.
        const proj = path.join(tmp, 'proj');
        fs.mkdirSync(path.join(proj, '.vscode'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: proj });
        fs.writeFileSync(path.join(proj, '.gitignore'), '.vscode/\n*.log\n');
        const marks = path.join(proj, '.vscode', 'notebook-headings.json');
        fs.writeFileSync(marks, '{}');
        fs.writeFileSync(path.join(proj, '.vscode', 'settings.json'), '{}');
        assert.ok(ignored(proj, marks));
        assert.equal(await api.fixGitIgnore(marks), path.join(proj, '.gitignore'));
        assert.equal(ignored(proj, marks), false, 'the marks file is kept');
        assert.ok(ignored(proj, '.vscode/settings.json'), 'the rest of .vscode stays ignored');
        assert.ok(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8').startsWith('.vscode/\n*.log\n'), 'existing lines are kept');
        // A project folder that is itself ignored by the repository: no fix helps.
        const outer = path.join(tmp, 'outer');
        const inner = path.join(outer, 'notes');
        fs.mkdirSync(path.join(inner, '.vscode'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: outer });
        fs.writeFileSync(path.join(outer, '.gitignore'), 'notes/\n');
        const innerMarks = path.join(inner, '.vscode', 'notebook-headings.json');
        fs.writeFileSync(innerMarks, '{}');
        assert.equal(await api.fixGitIgnore(innerMarks), undefined);
        assert.equal(fs.existsSync(path.join(inner, '.gitignore')), false, 'the .gitignore it tried is removed again');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  ],
  [
    'Marks file: git-ignored documents stay local, a broken file is never overwritten, deleted documents are forgotten',
    async () => {
      const { execFileSync } = require('node:child_process');
      const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const tmp = fs.mkdtempSync(path.join(wsRoot, 'nh-marks-'));
      // The repository inside the workspace folder keeps its own marks file.
      const rel = (p) => path.relative(tmp, p).split(path.sep).join('/');
      const marksPath = path.join(tmp, '.vscode', 'notebook-headings.json');
      const workspaceMarks = path.join(wsRoot, '.vscode', 'notebook-headings.json');
      const original = fs.readFileSync(workspaceMarks, 'utf8');
      const store = api.marksFile;
      const mark = { 0: { status: 'todo', text: 'A' } };
      try {
        execFileSync('git', ['init', '-q'], { cwd: tmp });
        fs.writeFileSync(path.join(tmp, '.gitignore'), 'private.md\n');
        const pub = vscode.Uri.file(path.join(tmp, 'public.md'));
        const priv = vscode.Uri.file(path.join(tmp, 'private.md'));
        for (const u of [pub, priv]) fs.writeFileSync(u.fsPath, '# A\n');
        await store.set(pub, mark);
        await store.set(priv, mark);
        const shared = JSON.parse(fs.readFileSync(marksPath, 'utf8')).marks;
        assert.ok(shared[rel(pub.fsPath)], 'the public document is in the shared file');
        assert.equal(shared[rel(priv.fsPath)], undefined, 'the ignored document is not');
        assert.deepEqual(store.get(priv), mark, 'its marks are kept on this computer');
        // Deleting documents forgets their marks.
        await store.forget([pub, priv]);
        assert.deepEqual(store.get(priv), {});
        assert.deepEqual(store.get(pub), {});
        assert.equal(fs.existsSync(marksPath), false, 'the emptied file is deleted');
        assert.equal(fs.readFileSync(workspaceMarks, 'utf8'), original, "the workspace folder's file is untouched");
        // A file with merge conflict markers is reported and left untouched.
        const conflict = '<<<<<<< HEAD\n{ "marks": {} }\n=======\n{ "marks": { "x.md": {} } }\n>>>>>>> other\n';
        fs.writeFileSync(marksPath, conflict);
        await assert.rejects(store.set(pub, mark));
        assert.equal(fs.readFileSync(marksPath, 'utf8'), conflict);
        assert.deepEqual(store.get(pub), {}, 'nothing is shown from a broken file');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  ],
  [
    'Outside the workspace: git is not run; repository files stay local, others travel with their folder',
    async () => {
      const { execFileSync } = require('node:child_process');
      const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nh-out-'));
      const mark = { 0: { status: 'todo', text: 'A' } };
      try {
        const repo = path.join(outside, 'repo');
        const plain = path.join(outside, 'plain');
        fs.mkdirSync(repo);
        fs.mkdirSync(plain);
        execFileSync('git', ['init', '-q'], { cwd: repo });
        const inRepo = vscode.Uri.file(path.join(repo, 'notes.md'));
        const inPlain = vscode.Uri.file(path.join(plain, 'notes.md'));
        for (const u of [inRepo, inPlain]) fs.writeFileSync(u.fsPath, '# A\n');
        await api.marksFile.set(inRepo, mark);
        await api.marksFile.set(inPlain, mark);
        // In a repository git may not be run for: kept on this computer.
        assert.equal(fs.existsSync(path.join(repo, '.vscode')), false);
        assert.deepEqual(api.marksFile.get(inRepo), mark);
        // Not in a repository: saved next to the file, so it travels with it.
        const saved = JSON.parse(fs.readFileSync(path.join(plain, '.vscode', 'notebook-headings.json'), 'utf8'));
        assert.ok(saved.marks['notes.md']);
        await api.marksFile.forget([inRepo, inPlain]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  ],
];

async function run() {
  const ext = vscode.extensions.getExtension('cuihuaxia.notebook-headings');
  api = (await ext.activate()).__test;
  await vscode.commands.executeCommand('notebookHeadings.view.focus');
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push(name);
      console.log(`not ok - ${name}\n  ${(err && err.stack) || err}`);
    }
  }
  console.log(`# ${tests.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
}

module.exports = { run };
