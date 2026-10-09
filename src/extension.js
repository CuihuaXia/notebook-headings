/**
 * extension.js — the VS Code side of Notebook Headings.
 *
 * Responsibilities:
 *   - decide which document the tree shows (the "source": the active Jupyter
 *     notebook or Markdown editor),
 *   - turn that document into plain inputs for src/headings.js and render the
 *     resulting tree in the "Notebook Headings" view,
 *   - keep the tree, the status bar and the editor in sync (clicks, cursor
 *     moves, scrolling, edits, settings changes),
 *   - provide the commands contributed in package.json,
 *   - offer a "Tags" button on notebook code cells for editing their tags,
 *   - mark headings with a status or a star.
 *
 * The only changes ever made to a document are cell metadata the user sets
 * explicitly: a cell's tags (tag picker) and a heading's marks (Set Status,
 * Add Star), each undoable with Cmd+Z. Code, text and outputs are never
 * touched.
 */
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const {
  parseNotebookHeadings,
  parseMarkdownHeadings,
  buildTree,
  assignNumbers,
  assignOutputSizes,
  formatBytes,
  assignColorRanks,
  applyFilter,
  headingAt,
  sectionRange,
  mergeRanges,
  ancestry,
  labelOf,
} = require('./headings');
const { COMMON_TAGS, isValidTag, multiPickerEntries, nextTagsMulti, sortKeysDeep } = require('./tags');
const {
  STATUSES,
  statusById,
  MARK_FILTERS,
  cleanMarks,
  matchesMarkFilter,
  readMarks,
  resolveMarks,
  updateMarks,
  combineMarks,
  occurrences,
  MARKS_KEY,
  assignMarks,
  summarizeMarks,
  iconFile,
  countsText,
  applyMarkedFilter,
} = require('./marks');

/** Id of the tree view (must match `contributes.views` in package.json). */
const VIEW_ID = 'notebookHeadings.view';

/**
 * Token embedded in every tree item id. VS Code remembers expansion state by
 * id, so a new token per window session guarantees that a freshly opened
 * window starts from the default expansion instead of a remembered one.
 */
const SESSION = Date.now().toString(36);

/**
 * URI scheme for the fake resources attached to tree items. TreeItem has no
 * label color property; the only way to color a label is a
 * FileDecorationProvider, which needs a resourceUri on the item. The rank is
 * carried in the query string (`notebook-heading:/level2?rank=2`).
 */
const DECO_SCHEME = 'notebook-heading';

/**
 * Codicon shown before a heading, by color rank (index 0 = page title).
 * Once labels are colored the icon slot is always occupied (otherwise VS Code
 * shows a file-type icon there), so it carries the level as a shape:
 * heavier shapes for shallower levels.
 */
const RANK_ICONS = [
  'book', // page title
  'circle-filled', // rank 1, usually ##
  'circle-outline', // rank 2, usually ###
  'primitive-square', // rank 3, usually ####
  'debug-breakpoint-function', // rank 4, usually ##### (filled triangle)
  'circle-small-filled', // rank 5, usually ######
  'circle-small', // rank 6, fallback
];

/** Folder of the status icons (media/status/<id>.svg); set in activate(). */
let statusIconDir;

/** Settings under the `notebookHeadings.` prefix (see package.json). */
const config = () => vscode.workspace.getConfiguration('notebookHeadings');

/**
 * Cached settings object. Drawing the tree reads settings several times per
 * heading, and each getConfiguration() call builds a new object in VS Code,
 * so it is read once and dropped when settings change (see activate()).
 */
let settingsCache;

/** A `notebookHeadings.` setting, from the cache. */
const setting = (key, fallback) => (settingsCache || (settingsCache = config())).get(key, fallback);

/** Theme color id for a rank, e.g. `notebookHeadings.level1Foreground`. */
const rankColor = (rank) => new vscode.ThemeColor(`notebookHeadings.level${rank}Foreground`);

/** Label of a node honoring the `numbering` setting. */
const label = (node) => labelOf(node, setting('numbering', true));

/** Translated UI text (falls back to English); see l10n/ and package.nls*.json. */
const t = vscode.l10n.t;

/** "1 cell" / "12 cells", "1 line" / "12 lines", translated. */
const cellsText = (n) => (n === 1 ? t('1 cell') : t('{0} cells', n));
const linesText = (n) => (n === 1 ? t('1 line') : t('{0} lines', n));

/** Shorten long text for the status bar and notifications. */
const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Trailing-edge debounce with a `cancel()` method. */
function debounce(fn, ms) {
  let timer;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

// ---------------------------------------------------------------------------
// Sources: the document the tree is showing
// ---------------------------------------------------------------------------
//
// A source is { kind, editor, doc }:
//   kind   'notebook' | 'markdown'
//   editor the NotebookEditor / TextEditor last seen showing the document
//   doc    the NotebookDocument / TextDocument (stable identity; the editor
//          object can change when tabs are switched, the document does not)

const notebookSource = (editor) => ({ kind: 'notebook', editor, doc: editor.notebook });
const markdownSource = (editor) => ({ kind: 'markdown', editor, doc: editor.document });

/**
 * A text editor whose document is a Markdown file. Markdown cells inside a
 * notebook also report languageId 'markdown'; they are excluded by their
 * `vscode-notebook-cell` URI scheme, since the notebook itself is the source.
 */
const isMarkdownEditor = (editor) =>
  !!editor &&
  editor.document.languageId === 'markdown' &&
  editor.document.uri.scheme !== 'vscode-notebook-cell' &&
  setting('markdown', true);

/** Whether the source's document is still shown in some editor group. */
function isVisible(source) {
  if (!source) return false;
  return source.kind === 'notebook'
    ? vscode.window.visibleNotebookEditors.some((e) => e.notebook === source.doc)
    : vscode.window.visibleTextEditors.some((e) => e.document === source.doc);
}

/** Cursor position in the source: selected cell index or cursor line. */
function cursorPos(source) {
  if (!source) return undefined;
  if (source.kind === 'notebook') return source.editor.selection ? source.editor.selection.start : undefined;
  return source.editor.selection.active.line;
}

/**
 * Bytes of output stored in a notebook cell. The outputs are already in
 * memory as byte arrays, so this only adds up their lengths; output content
 * is never parsed, which takes well under a millisecond even for notebooks
 * with thousands of cells.
 */
function cellOutputBytes(cell) {
  let bytes = 0;
  for (const output of cell.outputs || []) {
    for (const item of output.items || []) bytes += item.data ? item.data.byteLength : 0;
  }
  return bytes;
}

/** Whether a notebook cell is a Markdown cell. */
const isMarkdownCell = (cell) => cell.kind === vscode.NotebookCellKind.Markup;

/** Whether a notebook cell is a code cell (not Markdown). */
const isCodeCell = (cell) => cell.kind === vscode.NotebookCellKind.Code;

/**
 * The cells of a notebook covered by `[start, end)` ranges, in order. The
 * ranges must not overlap (see mergeRanges()); ends past the last cell are
 * clipped.
 *
 * @param {vscode.NotebookDocument} nb
 * @param {{ start: number, end: number }[]} ranges
 * @returns {vscode.NotebookCell[]}
 */
function cellsIn(nb, ranges) {
  const cells = [];
  for (const r of ranges) {
    for (let i = r.start; i < Math.min(r.end, nb.cellCount); i++) cells.push(nb.cellAt(i));
  }
  return cells;
}

/**
 * Whole lines `[start, end)` of a text document as a Range: up to the start
 * of line `end`, or to the very end of the file when the range reaches it.
 *
 * @param {vscode.TextDocument} doc
 * @param {{ start: number, end: number }} r
 * @returns {{ range: vscode.Range, lines: number }}
 */
function lineRange(doc, r) {
  const last = Math.min(r.end, doc.lineCount);
  const to = last < doc.lineCount ? new vscode.Position(last, 0) : doc.lineAt(last - 1).range.end;
  return { range: new vscode.Range(new vscode.Position(r.start, 0), to), lines: last - r.start };
}

/**
 * Headings and size (cell or line count) of a source's document, the output
 * size of every cell for notebooks, and the marks of its headings: `marks`
 * maps a heading's index in the document to its mark (with its text), and
 * `legacy` lists the headings whose mark is still in their cell's metadata
 * (saved by version 1.5; see combineMarks() in src/marks.js). A heading's
 * `slot` is its index in the document.
 *
 * @param {object} source
 * @param {MarksFile} marksFile where marks are kept
 */
function readSource(source, marksFile) {
  if (source.kind === 'notebook') {
    const nb = source.doc;
    const custom = useCustomMetadata();
    const cells = [];
    const cellBytes = [];
    const cellMarks = [];
    for (let i = 0; i < nb.cellCount; i++) {
      const cell = nb.cellAt(i);
      const isMarkdown = isMarkdownCell(cell);
      // Only Markdown cells are parsed, so code cell text is never read.
      cells.push({ isMarkdown, text: isMarkdown ? cell.document.getText() : '' });
      cellBytes.push(cellOutputBytes(cell));
      cellMarks.push(isMarkdown ? readMarks(jupyterMetaOf(cell, custom)) : {});
    }
    const headings = parseNotebookHeadings(cells).map((h, i) => ({ ...h, cellSlot: h.slot, slot: i }));
    const { marks, legacy } = combineMarks(headings, marksFile.get(nb.uri), (pos) => cellMarks[pos]);
    return { headings, total: nb.cellCount, cellBytes, marks, legacy };
  }
  const headings = parseMarkdownHeadings(source.doc.getText()).map((h, i) => ({ ...h, slot: i }));
  const texts = headings.map((h) => h.text);
  const occ = occurrences(texts);
  const marks = {};
  resolveMarks(marksFile.get(source.doc.uri), texts).forEach((m, i) => {
    if (m) marks[i] = { ...m, text: texts[i], ...(occ[i] ? { n: occ[i] } : {}) };
  });
  return { headings, total: source.doc.lineCount, marks, legacy: new Set() };
}

/** File holding the marks, relative to its root folder. */
const MARKS_FILE = path.join('.vscode', 'notebook-headings.json');

/**
 * Where marks are kept: `.vscode/notebook-headings.json` in the project, for
 * notebooks and Markdown files alike, so they travel with the project (git,
 * a cloud drive, another computer) and the documents themselves are never changed:
 *
 *     { "marks": { "code/Analysis.ipynb": { "4": { "status": "todo", "text": "Setup" } } } }
 *
 * The root is the workspace folder that holds the document, or the
 * document's own folder when it is outside every workspace folder; keys are
 * paths relative to the root, with `/`. Each entry maps a heading's index in
 * the document to its mark (see src/marks.js). The file is read on every
 * redraw (it is small), so a `git pull` shows up right away; it is deleted
 * when no mark is left. Documents that are not on disk (untitled or remote
 * virtual files) fall back to VS Code's workspace storage.
 */
class MarksFile {
  /** @param {vscode.Memento} state the extension's workspaceState (fallback) */
  constructor(state) {
    this.state = state;
    /** called with the marks file's path after a mark is saved in it */
    this.onWrite = undefined;
    /** invalid marks files already reported */
    this.reported = new Set();
  }

  /**
   * Marks file and key of a document, or undefined when it is not on disk.
   * The root is the workspace folder holding the document (or the document's
   * own folder outside every workspace folder) — or, when the document is in
   * a git repository inside that folder, the repository: a workspace folder
   * holding several repositories keeps each one's marks in that repository,
   * so they travel with it.
   */
  location(uri) {
    if (uri.scheme !== 'file') return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const base = folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : path.dirname(uri.fsPath);
    let root = base;
    for (let d = path.dirname(uri.fsPath); d.length > base.length && d.startsWith(base); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) {
        root = d;
        break;
      }
    }
    return { file: path.join(root, MARKS_FILE), key: path.relative(root, uri.fsPath).split(path.sep).join('/') };
  }

  /**
   * The contents of a marks file: an empty object when it does not exist.
   * A file that exists but is not valid JSON (for example with git conflict
   * markers after a merge) throws, so it is never overwritten and its marks
   * lost; the error is reported once per session.
   */
  read(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
      // reported below
    }
    const err = new Error(t('{0} is not valid JSON (a git merge conflict?). Fix it, then try again.', file));
    if (!this.reported.has(file)) {
      this.reported.add(file);
      vscode.window.showErrorMessage(`Notebook Headings: ${err.message}`, t('Open')).then((pick) => {
        if (pick) vscode.window.showTextDocument(vscode.Uri.file(file));
      });
    }
    throw err;
  }

  /** read(), but an unreadable file gives no marks instead of an error (for display). */
  readForDisplay(file) {
    try {
      return this.read(file);
    } catch {
      return {};
    }
  }

  /** Write a marks file, or delete it when nothing is left in it. */
  async write(file, data) {
    if (data.marks && !Object.keys(data.marks).length) delete data.marks;
    if (!Object.keys(data).length) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(sortKeysDeep(data), null, 2) + '\n');
  }

  /** Key of a document's marks in the workspace storage (this computer only). */
  localKey(uri) {
    return `marks|${uri.toString()}`;
  }

  /** Documents at or under `uri` with marks in the workspace storage: [uri, marks] pairs. */
  localUnder(uri) {
    const prefix = this.localKey(uri);
    return this.state
      .keys()
      .filter((k) => k === prefix || k.startsWith(prefix + '/'))
      .map((k) => [vscode.Uri.parse(k.slice('marks|'.length)), this.state.get(k)]);
  }

  /** The stored marks of a document, cleaned up. */
  get(uri) {
    const loc = this.location(uri);
    const all = loc && this.readForDisplay(loc.file).marks;
    const shared = all && all[loc.key];
    return cleanMarks(shared || this.state.get(this.localKey(uri)));
  }

  /**
   * Whether a document's marks must stay on this computer: documents not on
   * disk, documents that git ignores (kept out of the repository on purpose,
   * so their path and heading texts must not reach it through the marks
   * file), and documents in a git repository that git may not be run for
   * (outside a trusted workspace folder; see gitAllowed()), where whether
   * they are ignored cannot be checked.
   */
  async isLocal(uri) {
    if (!this.location(uri)) return true;
    const dir = path.dirname(uri.fsPath);
    if (!gitAllowed(dir)) return insideGitRepo(dir);
    return gitIgnores(uri.fsPath, dir);
  }

  /**
   * Replace the marks of a document; an empty object removes them. They go to
   * the project's marks file, or to the workspace storage on this computer for
   * documents that must stay local (see isLocal()).
   */
  async set(uri, marks) {
    const empty = !Object.keys(marks).length;
    const loc = this.location(uri);
    const local = !empty && (await this.isLocal(uri));
    await this.state.update(this.localKey(uri), local ? marks : undefined);
    if (!loc) return;
    // Removing an entry tolerates a broken file (there is nothing to remove
    // from it); adding one does not, so it is never overwritten.
    const data = local || empty ? this.readForDisplay(loc.file) : this.read(loc.file);
    const all = data.marks && typeof data.marks === 'object' ? data.marks : {};
    if (local || empty) {
      if (!(loc.key in all)) return; // nothing to remove; leave the file alone
      delete all[loc.key];
    } else {
      all[loc.key] = marks;
    }
    data.marks = all;
    await this.write(loc.file, data);
    if (!local && !empty && this.onWrite) this.onWrite(loc.file);
  }

  /**
   * Forget the marks of deleted documents (or of every document in a deleted
   * folder). Only deletions made in VS Code are seen.
   *
   * @param {vscode.Uri[]} uris
   */
  async forget(uris) {
    for (const uri of uris) {
      for (const [local] of this.localUnder(uri)) await this.state.update(this.localKey(local), undefined);
      const loc = this.location(uri);
      if (!loc) continue;
      const all = this.readForDisplay(loc.file).marks || {};
      const gone = Object.keys(all).filter((k) => k === loc.key || k.startsWith(loc.key + '/'));
      for (const key of gone) await this.set(vscode.Uri.file(path.join(path.dirname(loc.file), '..', ...key.split('/'))), {});
    }
  }

  /**
   * Move marks along when documents or folders are renamed or moved in VS Code.
   * Entries are re-keyed within one marks file, or moved to another one when
   * the new place has a different root.
   *
   * @param {{ oldUri: vscode.Uri, newUri: vscode.Uri }[]} renames
   */
  async rename(renames) {
    for (const { oldUri, newUri } of renames) {
      // Marks kept on this computer (see set()).
      for (const [uri, marks] of this.localUnder(oldUri)) {
        const moved = vscode.Uri.file(path.join(newUri.fsPath, path.relative(oldUri.fsPath, uri.fsPath)));
        await this.state.update(this.localKey(moved), marks);
        await this.state.update(this.localKey(uri), undefined);
      }
      const from = this.location(oldUri);
      if (!from) continue;
      const all = this.readForDisplay(from.file).marks || {};
      // A renamed file is its own key; a renamed folder is a prefix of keys.
      const moved = Object.keys(all).filter((k) => k === from.key || k.startsWith(from.key + '/'));
      for (const key of moved) {
        const oldFile = vscode.Uri.file(path.join(path.dirname(from.file), '..', ...key.split('/')));
        const newFile = vscode.Uri.file(path.join(newUri.fsPath, path.relative(oldUri.fsPath, oldFile.fsPath)));
        const marks = cleanMarks(all[key]);
        // Save under the new name first, so a failure cannot lose them.
        await this.set(newFile, marks);
        await this.set(oldFile, {});
      }
    }
  }
}

/**
 * Run git in a folder. Resolves with the exit code (0 = success) and output;
 * a missing git, a timeout or a folder outside any repository give a
 * non-zero code, never an error.
 *
 * Only for folders of a trusted workspace (see gitAllowed()), and with
 * `core.fsmonitor` off: a repository's own config could otherwise make git
 * start a program of its choosing.
 */
function git(args, cwd) {
  return new Promise((resolve) => {
    if (!gitAllowed(cwd)) return resolve({ code: -1, stdout: '' });
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 5000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '' });
    });
  });
}

/** Whether a folder is inside a git repository (looks for `.git`; does not run git). */
function insideGitRepo(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** Whether git may run in a folder: a trusted workspace, inside one of its folders. */
function gitAllowed(dir) {
  if (!vscode.workspace.isTrusted) return false;
  return !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
}

/** Marks files already checked in this session. */
const gitChecked = new Set();

/** Whether git ignores a path (false outside a repository or without git). */
const gitIgnores = async (target, cwd) => (await git(['check-ignore', '-q', target], cwd)).code === 0;

/**
 * Change the project's .gitignore so git keeps the marks file, without
 * changing what else it ignores. Lines are appended to the .gitignore next to
 * `.vscode/` (it takes precedence over global and .git/info/exclude rules):
 * - when a rule ignores the whole `.vscode` folder, git cannot re-include a
 *   file inside it, so the folder is re-included, its contents ignored
 *   again, and only the marks file let through;
 * - otherwise one line re-includes the marks file.
 * The result is checked with git; if the file is still ignored (e.g. the
 * project folder itself is ignored), the .gitignore is put back as it was.
 *
 * @param {string} file path of the marks file
 * @returns {Promise<string|undefined>} the .gitignore changed, or undefined
 */
async function fixGitIgnore(file) {
  const root = path.dirname(path.dirname(file));
  const gitignore = path.join(root, '.gitignore');
  const folderIgnored = await gitIgnores('.vscode/', root);
  const lines = folderIgnored
    ? ['!/.vscode/', '/.vscode/*', '!/.vscode/notebook-headings.json']
    : ['!/.vscode/notebook-headings.json'];
  let before;
  try {
    before = fs.readFileSync(gitignore, 'utf8');
  } catch {
    before = undefined;
  }
  // Keep the file's line endings.
  const eol = before && before.includes('\r\n') ? '\r\n' : '\n';
  const block = ['# Notebook Headings: keep heading marks with the project', ...lines].join(eol) + eol;
  const after = before ? `${before.replace(/(\r?\n)*$/, eol)}${eol}${block}` : block;
  await fs.promises.writeFile(gitignore, after);
  if (!(await gitIgnores(file, root))) return gitignore;
  if (before === undefined) await fs.promises.rm(gitignore, { force: true });
  else await fs.promises.writeFile(gitignore, before);
  return undefined;
}

/**
 * Marks should travel with the project, so warn once when git ignores the
 * marks file (e.g. a `.vscode/` line in .gitignore): it would then never reach
 * the user's other computers. Offers to fix .gitignore in one click (see
 * fixGitIgnore()), to open the rule that ignores the file, or to stop asking
 * for this project.
 *
 * @param {string} file path of the marks file
 * @param {vscode.Memento} state the extension's workspaceState
 */
async function warnIfGitIgnored(file, state) {
  const quietKey = `gitignoreQuiet|${file}`;
  if (gitChecked.has(file) || state.get(quietKey)) return;
  gitChecked.add(file);
  const cwd = path.dirname(file);
  if (!(await gitIgnores(file, cwd))) return;
  // "<source>:<line>:<pattern>\t<path>": where the ignoring rule is. The
  // source is relative to the repository root (or absolute, or starts with ~
  // for a global excludes file).
  const m = (await git(['check-ignore', '-v', file], cwd)).stdout.match(/^(.*):(\d+):(.*)\t/);
  const top = (await git(['rev-parse', '--show-toplevel'], cwd)).stdout.trim() || cwd;
  const source = m && (m[1].startsWith('~/') ? path.join(os.homedir(), m[1].slice(2)) : path.resolve(top, m[1]));
  const rule = m ? { source, line: Number(m[2]), pattern: m[3] } : undefined;
  const fix = t('Fix .gitignore');
  const open = rule ? t('Open {0}', path.basename(rule.source)) : undefined;
  const quiet = t("Don't Show Again");
  const answer = await vscode.window.showWarningMessage(
    t(
      'Notebook Headings: git ignores {0}{1}, so your marks will not reach your other computers. "Fix .gitignore" adds the lines that let git keep this one file; nothing else changes.',
      MARKS_FILE.split(path.sep).join('/'),
      rule ? t(' (rule "{0}" in {1}, line {2})', rule.pattern, path.basename(rule.source), rule.line) : ''
    ),
    ...[fix, open, quiet].filter(Boolean)
  );
  if (answer === quiet) await state.update(quietKey, true);
  if (answer === open && rule) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rule.source));
    const at = new vscode.Position(Math.max(rule.line - 1, 0), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Selection(at, at) });
  }
  if (answer === fix) {
    let changed;
    try {
      changed = await fixGitIgnore(file);
    } catch (err) {
      vscode.window.showErrorMessage(t('Notebook Headings: could not change .gitignore ({0}).', err.message));
      return;
    }
    if (!changed) {
      vscode.window.showWarningMessage(
        t('Notebook Headings: .gitignore was left unchanged: git would still ignore the marks file (is the project folder itself ignored?).')
      );
      return;
    }
    const show = t('Show');
    const done = await vscode.window.showInformationMessage(
      t('Notebook Headings: updated .gitignore; commit .vscode/notebook-headings.json to take your marks along.'),
      show
    );
    if (done === show) await vscode.window.showTextDocument(vscode.Uri.file(changed));
  }
}

// ---------------------------------------------------------------------------
// Cell tags
// ---------------------------------------------------------------------------
//
// Tags are stored the same way the Jupyter extension and its "Jupyter Cell
// Tags" companion store them, so all of them see the same list: in
// `metadata.metadata.tags`, or in `metadata.custom.metadata.tags` with older
// versions of VS Code's built-in ipynb support (which no longer exports
// `dropCustomMetadata`). That is where Jupyter, Jupyter Book and nbconvert
// read them in the saved .ipynb file.

/** Whether this VS Code still keeps Jupyter metadata under `custom`. */
function useCustomMetadata() {
  const ipynb = vscode.extensions.getExtension('vscode.ipynb');
  return !(ipynb && ipynb.exports && ipynb.exports.dropCustomMetadata);
}

/**
 * A cell's Jupyter metadata (the object saved as the cell's "metadata" in
 * the .ipynb file), read-only.
 *
 * @param {object} cell
 * @param {boolean} [custom] result of useCustomMetadata(), when already known
 */
function jupyterMetaOf(cell, custom = useCustomMetadata()) {
  const md = cell.metadata || {};
  const holder = custom ? md.custom : md;
  return (holder && holder.metadata) || {};
}

/** A cell's VS Code metadata with its Jupyter metadata replaced; everything else is kept. */
function metadataWithJupyter(cell, jupyterMeta) {
  const md = JSON.parse(JSON.stringify(cell.metadata || {}));
  const holder = useCustomMetadata() ? ((md.custom = md.custom || {}), md.custom) : md;
  holder.metadata = jupyterMeta;
  return sortKeysDeep(md);
}

/** A notebook cell's current tags (a copy). */
function getCellTags(cell) {
  const tags = jupyterMetaOf(cell).tags;
  return Array.isArray(tags) ? [...tags] : [];
}

/** A cell's Jupyter metadata with its tags replaced; everything else is kept. */
function metadataWithTags(cell, tags) {
  const meta = JSON.parse(JSON.stringify(jupyterMetaOf(cell)));
  if (tags.length) meta.tags = tags;
  else delete meta.tags;
  return meta;
}

/**
 * Replace the Jupyter metadata of one or more cells of a notebook in a single
 * WorkspaceEdit, so one Cmd+Z undoes the whole change. Used for tags and
 * marks, the only edits this extension makes.
 *
 * @param {[object, object][]} changes [cell, its new Jupyter metadata] pairs
 */
async function setJupyterMetadata(changes) {
  if (!changes.length) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.set(
    changes[0][0].notebook.uri,
    changes.map(([cell, meta]) => vscode.NotebookEdit.updateCellMetadata(cell.index, metadataWithJupyter(cell, meta)))
  );
  return vscode.workspace.applyEdit(edit);
}

/** Replace the tags of one or more cells as one undoable edit. */
const setCellTags = (changes) => setJupyterMetadata(changes.map(({ cell, tags }) => [cell, metadataWithTags(cell, tags)]));

/** Cells covered by a notebook editor's selections, in order, without repeats. */
function selectedCells(editor) {
  if (!editor) return [];
  const selections = editor.selections || (editor.selection ? [editor.selection] : []);
  return cellsIn(editor.notebook, mergeRanges(selections.map((r) => ({ start: r.start, end: r.end }))));
}

/** The "Tags" button at the bottom right of code cells (and of tagged Markdown cells). */
class CellTagButton {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCellStatusBarItems = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire();
  }

  provideCellStatusBarItems(cell) {
    if (!setting('cellTagButton', true)) return [];
    const tags = getCellTags(cell);
    // The offered tags collapse code and outputs, so the button belongs on code
    // cells; a Markdown cell shows it only when it already has tags to edit.
    if (!isCodeCell(cell) && !tags.length) return [];
    return [
      {
        text: tags.length ? `$(tag) ${tags.length}` : `$(tag) ${t('Tags')}`,
        tooltip: tags.length ? t('Tags: {0} — click to edit', tags.join(', ')) : t('Click to set tags for this cell'),
        command: { title: t('Edit Cell Tags'), command: 'notebookHeadings.editCellTags', arguments: [cell] },
        alignment: vscode.NotebookCellStatusBarAlignment.Right,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Label colors
// ---------------------------------------------------------------------------

/** Colors tree labels by rank via their `notebook-heading:` resource URI. */
class LevelDecorations {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChange.event;
  }

  /** Re-query every decoration (after a settings or theme change). */
  refresh() {
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== DECO_SCHEME || !setting('levelColors', true)) return undefined;
    const rank = Number(new URLSearchParams(uri.query).get('rank'));
    return rank ? { color: rankColor(rank) } : undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

/**
 * Supplies the heading tree of the current source to the tree view, and
 * tracks the state that VS Code does not expose: which nodes the user has
 * expanded or collapsed, and the active filter.
 */
class HeadingsProvider {
  /** @param {MarksFile} marksFile where marks are kept */
  constructor(marksFile) {
    this.marksFile = marksFile;
    /** marks of the current document by heading index, with texts (see readSource()) */
    this.marks = {};
    /** heading indexes whose mark is still in cell metadata (version 1.5) */
    this.legacy = new Set();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.source = undefined;
    this.roots = [];
    this.flat = [];
    /** tree item id -> heading node, rebuilt with the tree */
    this.byId = new Map();
    this.filter = '';
    /**
     * "Show Marked Headings": undefined (off), 'marked' (starred headings and
     * open statuses), 'star' or a status id; see MARK_FILTERS in src/marks.js
     */
    this.markFilter = undefined;
    /** headings passing markFilter */
    this.markedCount = 0;
    /** the "Starred" group shown above the headings, or undefined */
    this.starGroup = undefined;
    /** called after every rebuild (updates the view's filter description) */
    this.afterRebuild = undefined;
    /** document uri -> counter bumped by "Collapse to Default Level" */
    this.generations = new Map();
    /** tree item id -> expansion chosen by the user (overrides the default) */
    this.expanded = new Map();
  }

  /** Whether the tree shows a filtered subset (text filter or marked only). */
  get filtering() {
    return !!this.filter || !!this.markFilter;
  }

  setSource(source) {
    this.source = source;
    // Lets package.json show notebook-only menu items (tags, outputs).
    vscode.commands.executeCommand('setContext', 'notebookHeadings.isNotebook', !!source && source.kind === 'notebook');
    this.rebuild();
  }

  /**
   * Back to the default expansion. Changing the id prefix makes VS Code treat
   * every item as new, so each one takes its initial collapsible state again.
   */
  resetExpansion() {
    if (!this.source) return;
    const uri = this.source.doc.uri.toString();
    this.generations.set(uri, (this.generations.get(uri) || 0) + 1);
    this.expanded.clear();
    this.rebuild();
  }

  /** Text filter; replaces "Show Marked Headings". */
  setFilter(query) {
    this.filter = query.trim();
    this.markFilter = undefined;
    this.applyFilters();
    this._onDidChange.fire();
  }

  /** "Show Marked Headings" with a kind (see markFilter), or off; replaces the text filter. */
  setMarkFilter(kind) {
    this.markFilter = kind;
    this.filter = '';
    this.applyFilters();
    this._onDidChange.fire();
  }

  applyFilters() {
    if (this.markFilter) this.markedCount = applyMarkedFilter(this.roots, this.markFilter);
    else applyFilter(this.roots, this.filter);
  }

  /** Re-read the source document and redraw the whole tree. */
  rebuild() {
    const src = this.source;
    this.starGroup = undefined;
    if (!src) {
      this.roots = [];
      this.flat = [];
      this.byId = new Map();
      this.marks = {};
      this.legacy = new Set();
    } else {
      const uri = src.doc.uri.toString();
      const prefix = `${SESSION}|${this.generations.get(uri) || 0}|${uri}|`;
      const { headings, total, cellBytes, marks, legacy } = readSource(src, this.marksFile);
      this.marks = marks;
      this.legacy = legacy;
      ({ roots: this.roots, flat: this.flat } = buildTree(headings, prefix, total));
      this.byId = new Map(this.flat.map((n) => [n.id, n]));
      if (cellBytes) assignOutputSizes(this.flat, cellBytes);
      assignNumbers(this.roots, setting('numberH1', false));
      assignColorRanks(this.flat);
      // Marks are already matched to headings: one container, slots = indexes.
      assignMarks(this.flat, () => marks, setting('inProgressMarkers', ['???', '？？？']), () => 0);
      summarizeMarks(this.roots);
      const starred = this.flat.filter((n) => n.star);
      if (starred.length) {
        const group = { group: true, id: `${prefix}|starred`, text: t('Starred'), level: 0, children: [] };
        group.children = starred.map((n) => ({ ref: n, id: `${n.id}|starred`, text: n.text, level: n.level, children: [], parent: group }));
        this.starGroup = group;
      }
      this.applyFilters();
    }
    this._onDidChange.fire();
    if (this.afterRebuild) this.afterRebuild();
  }

  /**
   * Whether the tree currently shows this node's children: always while a
   * filter is active, otherwise the user's choice, otherwise the default
   * (expanded when shallower than `defaultExpandLevel`; the Starred group
   * starts expanded).
   */
  isExpanded(node) {
    if (!node.children.length) return false;
    if (this.filtering && !node.group) return true;
    const chosen = this.expanded.get(node.id);
    if (chosen !== undefined) return chosen;
    return node.group ? true : node.level < setting('defaultExpandLevel', 2);
  }

  /**
   * The node to highlight for a heading: the heading itself, or — if it is
   * hidden inside a collapsed parent — the deepest ancestor that is
   * currently visible. Following the cursor thus
   * never expands the tree on its own.
   */
  visibleHeadingFor(node) {
    if (!node || !node.visible) return undefined;
    for (const n of ancestry(node)) {
      if (n === node || !this.isExpanded(n)) return n;
    }
    return node;
  }

  // --- TreeDataProvider interface ---------------------------------------------

  getChildren(node) {
    if (node && (node.group || node.ref)) return node.children;
    const list = node ? node.children : this.roots;
    const shown = this.filtering ? list.filter((n) => n.visible) : list;
    // The Starred group sits above the headings, except while filtering.
    return !node && this.starGroup && !this.filtering ? [this.starGroup, ...shown] : shown;
  }

  /** Required by TreeView.reveal(). */
  getParent(node) {
    if (node.ref) return node.parent;
    if (node.group) return undefined;
    return node.parent && node.parent.level > 0 ? node.parent : undefined;
  }

  getTreeItem(node) {
    if (node.group) return this.groupItem(node);
    const ref = node.ref;
    if (ref) node = ref;
    const text = label(node);
    const treeLabel = { label: text };
    if (!ref && node.matchAt >= 0) {
      // The match index is relative to node.text; shift past the number prefix.
      const start = text.length - node.text.length + node.matchAt;
      treeLabel.highlights = [[start, start + this.filter.length]];
    }

    let state = vscode.TreeItemCollapsibleState.None;
    if (!ref && this.getChildren(node).length) {
      state = this.isExpanded(node)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    }

    const item = new vscode.TreeItem(treeLabel, state);
    // Filtered views get their own ids so their all-expanded state never
    // leaks into the normal tree; starred shortcuts have their own too.
    if (ref) item.id = `${node.id}|starred`;
    else if (this.markFilter) item.id = `${node.id}|marked:${this.markFilter}`;
    else item.id = this.filter ? `${node.id}|filter:${this.filter}` : node.id;
    // Menus in package.json tell headings (and starred ones) apart by this.
    item.contextValue = node.star ? 'heading.starred' : 'heading';

    const notebook = this.source && this.source.kind === 'notebook';
    const size = notebook ? formatBytes(node.bytes) : '';
    const status = node.status && statusById(node.status);
    const lines = [`${'#'.repeat(node.level)} ${node.text}`, notebook ? cellsText(node.size) : t('line {0}', node.pos + 1)];
    if (size) lines.push(t('outputs: {0}', size));
    if (status) lines.push(node.autoStatus ? t('Status: {0} (from the heading text)', t(status.label)) : t('Status: {0}', t(status.label)));
    if (node.star) lines.push(t('Starred'));
    const counts = countsText(node.counts);
    if (counts) lines.push(t('Marks below: {0}', counts));
    // First-level sections show every status they hold (theirs and their
    // subsections', finished included) as one 2×2 grid icon.
    const group = node.rank === 1 && node.below && node.below.size ? new Set([...node.below, ...(node.status ? [node.status] : [])]) : undefined;
    if (group) {
      const names = STATUSES.filter((st) => group.has(st.id)).map((st) => t(st.label));
      lines.push(t('Statuses in this section: {0}', names.join(', ')));
    }
    item.tooltip = lines.join('\n');

    // Description: "34 · 2.1 MB · ○2 ➤1 ✓3 ★2" (cells, output size, then the
    // statuses and stars below the heading, at any depth). Starred shortcuts
    // show their path instead.
    const parts = [];
    if (ref) {
      const path = ancestry(node).slice(0, -1).filter((n) => n.rank !== 0);
      if (path.length) parts.push(path.map(label).join(' › '));
    } else {
      if (notebook && setting('showCellCount', true)) parts.push(`${node.size}`);
      if (size && setting('showOutputSize', true)) parts.push(size);
      if (counts) parts.push(counts);
    }
    if (parts.length) item.description = parts.join(' · ');

    // A status, star or (first-level) grid of statuses replaces the level
    // shape so marked sections stand out; see iconFile() in src/marks.js.
    const marked = iconFile({ status: node.status, star: node.star, group });
    if (marked) {
      item.iconPath = vscode.Uri.joinPath(statusIconDir, marked);
    } else if (setting('levelColors', true)) {
      // An explicit icon keeps VS Code from showing a file-type icon for the
      // resource URI; the title gets one too so all levels indent equally.
      item.iconPath = new vscode.ThemeIcon(RANK_ICONS[node.rank], node.rank ? rankColor(node.rank) : undefined);
    }
    if (setting('levelColors', true) && node.rank) {
      item.resourceUri = vscode.Uri.from({
        scheme: DECO_SCHEME,
        // Must not start with "//" (invalid without an authority).
        path: `/level${node.rank}`,
        query: `rank=${node.rank}`,
      });
    }

    item.command = { command: 'notebookHeadings.reveal', title: 'Go to Heading', arguments: [node] };
    return item;
  }

  /** The "Starred" group above the headings. */
  groupItem(group) {
    const state = this.isExpanded(group)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(group.text, state);
    item.id = group.id;
    item.contextValue = 'starredGroup';
    item.iconPath = vscode.Uri.joinPath(statusIconDir, 'star.svg');
    item.description = `${group.children.length}`;
    item.tooltip = t('Starred headings, in document order. Right-click a heading → Remove Star to take it off.');
    return item;
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Entry point, called by VS Code the first time a notebook or Markdown file
 * is opened (see `activationEvents` in package.json).
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  statusIconDir = vscode.Uri.joinPath(context.extensionUri, 'media', 'status');
  const marksFile = new MarksFile(context.workspaceState);
  marksFile.onWrite = (file) => warnIfGitIgnored(file, context.workspaceState);
  const provider = new HeadingsProvider(marksFile);
  const decorations = new LevelDecorations();
  const tagButton = new CellTagButton();
  // canSelectMany: Cmd/Ctrl-click and Shift-click select several headings,
  // which Select Section and the copy commands then act on together.
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: true,
  });

  const status = vscode.window.createStatusBarItem('notebookHeadings.status', vscode.StatusBarAlignment.Left, 50);
  status.name = t('Notebook Headings: Current Section');
  status.command = `${VIEW_ID}.focus`; // auto-generated "focus this view" command

  // --- following the cursor: status bar + tree highlight ----------------------

  /** Last node revealed in the tree; avoids re-revealing on every event. */
  let lastRevealed;

  /**
   * The heading last jumped to from the tree or Go to Heading. A notebook
   * cell can hold several headings, and a position (a cell index) alone would
   * always name the last of them; while the cursor stays in that cell, the
   * heading actually chosen is shown instead.
   */
  let pinned;

  /** The heading of a position: the pinned one if it is in that cell, else the last one at or before it. */
  const headingFor = (pos) => {
    if (pos === undefined) return undefined;
    if (pinned && pinned.pos === pos) {
      const fresh = provider.byId.get(pinned.id);
      if (fresh && fresh.pos === pos) return fresh;
    }
    pinned = undefined;
    return headingAt(provider.flat, pos);
  };

  /** Show the exact section of `pos` in the status bar. */
  const updateStatus = (pos) => {
    const node = headingFor(pos);
    if (!node || !setting('statusBar', true)) return status.hide();
    status.text = `$(list-tree) ${truncate(label(node), 48)}`;
    status.tooltip = ancestry(node).map(label).join('  ›  ') + '\n\n' + t('Click to show the headings view');
    status.show();
  };

  /**
   * Time until which scroll events are ignored: clicking a heading scrolls
   * the editor, and following that scroll would re-select a (often
   * different) heading in the tree, breaking Cmd/Shift-click multi-selection.
   */
  let ignoreScrollUntil = 0;
  const quietScroll = () => {
    ignoreScrollUntil = Date.now() + 1000;
  };

  /**
   * Select the section of `pos` in the tree (or its visible ancestor).
   *
   * @param {number} pos cell index or line
   * @param {boolean} [userMoved] the user moved the cursor in the editor
   *        (not a scroll, an edit, or a selection this extension made)
   */
  const follow = (pos, userMoved = false) => {
    if (pos === undefined || !view.visible || !setting('followCursor', true)) return;
    // Don't replace a multi-selection the user built in the tree because of a
    // scroll or an edit; once they move the cursor in the editor themselves,
    // following resumes.
    const multi = view.selection && view.selection.length > 1;
    if (!userMoved && multi) return;
    const node = provider.visibleHeadingFor(headingFor(pos));
    // Skip a repeat reveal, except when it collapses a multi-selection back
    // to the heading under the user's cursor.
    if (!node || (node === lastRevealed && !multi)) return;
    lastRevealed = node;
    // focus: false keeps keyboard focus in the editor; expand: false never
    // opens collapsed sections. Errors (e.g. a stale node) are harmless.
    view.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {});
  };

  const onPosition = (pos, userMoved = false) => {
    updateStatus(pos);
    follow(pos, userMoved);
  };
  /** Cursor moved in the editor: by the user, unless we just moved it. */
  const onCursor = (pos) => onPosition(pos, Date.now() >= ignoreScrollUntil);
  /**
   * Scrolling fires many events; only react once it settles. A scroll this
   * extension caused is ignored entirely: the cursor move that came with it
   * already set the status bar, and the top visible line can be above the
   * heading (a text editor keeps a few lines of context above it).
   */
  const onScroll = debounce((pos) => {
    if (Date.now() >= ignoreScrollUntil) onPosition(pos);
  }, 150);

  /** Typing fires many change events; re-parse once it pauses. */
  const scheduleRebuild = debounce(() => {
    provider.rebuild();
    onPosition(cursorPos(provider.source));
  }, 300);

  // --- source tracking -------------------------------------------------------------

  /**
   * Point the tree at the active notebook or Markdown editor. When focus
   * moves somewhere without a document (the tree itself, the terminal, …)
   * the current source is kept as long as it is still visible.
   */
  const track = () => {
    const nb = vscode.window.activeNotebookEditor;
    const te = vscode.window.activeTextEditor;
    const next = nb ? notebookSource(nb) : isMarkdownEditor(te) ? markdownSource(te) : undefined;
    const cur = provider.source;
    if (next && cur && next.doc === cur.doc) {
      cur.editor = next.editor; // same document, possibly a new editor object
      return;
    }
    // A Markdown file stays shown while focus is elsewhere, unless Markdown
    // support has just been turned off.
    const keep = isVisible(cur) && !(cur.kind === 'markdown' && !setting('markdown', true));
    if (next) provider.setSource(next);
    else if (!keep) provider.setSource(undefined);
    else return;
    pinned = undefined;
    lastRevealed = undefined;
    onPosition(cursorPos(provider.source));
  };

  const isSourceDoc = (doc) => !!provider.source && provider.source.doc === doc;

  // --- filter ---------------------------------------------------------------------------

  /** View description ("query" · N matches) and the context key that swaps
   *  the search / clear buttons in the view toolbar. */
  const updateFilterUi = () => {
    const q = provider.filter;
    const matches = q ? provider.flat.filter((n) => n.matchAt >= 0).length : 0;
    if (provider.markFilter) view.description = `${markFilterLabel(provider.markFilter)} · ${provider.markedCount}`;
    else view.description = q ? `"${q}" · ${matches === 1 ? t('1 match') : t('{0} matches', matches)}` : undefined;
    vscode.commands.executeCommand('setContext', 'notebookHeadings.filtering', provider.filtering);
  };

  // Match and mark counts change whenever the tree is rebuilt (edits, marks,
  // settings, switching documents).
  provider.afterRebuild = updateFilterUi;

  const setFilter = (q) => {
    provider.setFilter(q);
    lastRevealed = undefined;
    updateFilterUi();
  };

  /** Short name of a mark filter kind, for the view description and the picker. */
  const markFilterLabel = (kind) => {
    if (kind === 'marked') return t('Marked headings');
    if (kind === 'star') return t('Starred');
    return t(statusById(kind).label);
  };

  /**
   * "Show Marked Headings": pick what to show — every marked heading
   * (starred or with an open status), only starred ones, or one status —
   * with the number of headings each choice shows.
   */
  const showMarked = async () => {
    const count = (kind) => provider.flat.filter((n) => matchesMarkFilter(n, kind)).length;
    if (!provider.flat.some((n) => n.star || n.status)) {
      vscode.window.showInformationMessage(t('Notebook Headings: no starred headings or statuses yet. Right-click a heading to set one.'));
      return;
    }
    const icon = (kind) => (kind === 'marked' ? 'bookmark' : kind === 'star' ? 'star-full' : statusById(kind).icon);
    const items = MARK_FILTERS.map((kind) => ({
      label: `$(${icon(kind)}) ${markFilterLabel(kind)}`,
      description: kind === 'marked' ? t('starred and open · {0}', count(kind)) : `${count(kind)}`,
      kind,
    }));
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = t('Show headings that are…');
    const current = items.find((i) => i.kind === (provider.markFilter || 'marked'));
    if (current) qp.activeItems = [current];
    qp.onDidAccept(() => {
      const [pick] = qp.selectedItems;
      qp.hide();
      if (!pick) return;
      provider.setMarkFilter(pick.kind);
      lastRevealed = undefined;
      updateFilterUi();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  };
  const liveFilter = debounce(setFilter, 120);

  /** Input box that filters as you type; Enter keeps, Esc restores. */
  const promptFilter = () => {
    const before = provider.filter;
    const box = vscode.window.createInputBox();
    let accepted = false;
    box.placeholder = t('Filter headings (Enter to keep, Esc to cancel)');
    box.value = before;
    box.onDidChangeValue(liveFilter);
    box.onDidAccept(() => {
      accepted = true;
      liveFilter.cancel();
      setFilter(box.value);
      box.hide();
    });
    box.onDidHide(() => {
      liveFilter.cancel();
      if (!accepted) setFilter(before);
      box.dispose();
    });
    box.show();
  };

  // --- navigation -----------------------------------------------------------------------

  /**
   * Scroll the document so the heading is at the top and select it.
   * @param {object} node
   * @param {boolean} focusEditor move keyboard focus to the editor (used by
   *        Go to Heading; tree clicks keep focus in the tree)
   */
  const revealHeading = async (node, focusEditor = false) => {
    const src = provider.source;
    if (!src || !node) return;
    // Use the current position even if the tree or the Go to Heading list was
    // built before an edit.
    node = provider.byId.get(node.id) || node;
    lastRevealed = node;
    pinned = node;
    quietScroll();
    // Right away: moving within the same cell fires no selection event.
    updateStatus(node.pos);
    if (src.kind === 'notebook') {
      if (node.pos >= src.doc.cellCount) return; // stale node after an edit
      const range = new vscode.NotebookRange(node.pos, node.pos + 1);
      const editor = await vscode.window.showNotebookDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        selections: [range],
        preserveFocus: !focusEditor,
      });
      editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
    } else {
      if (node.pos >= src.doc.lineCount) return;
      const editor = await vscode.window.showTextDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        preserveFocus: !focusEditor,
      });
      const at = new vscode.Position(node.pos, 0);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
    }
  };

  /** "Go to Heading…": a searchable list of all headings. */
  const quickJump = () => {
    if (!provider.source || !provider.flat.length) {
      vscode.window.showInformationMessage(t('Notebook Headings: no headings in the current editor.'));
      return;
    }
    const notebook = provider.source.kind === 'notebook';
    const current = headingAt(provider.flat, cursorPos(provider.source));
    const items = provider.flat.map((node) => ({
      // Em spaces indent by depth; $(icon) renders the level shape.
      label: `${' '.repeat(ancestry(node).length - 1)}$(${node.status ? statusById(node.status).icon : RANK_ICONS[node.rank]}) ${node.star ? '$(star-full) ' : ''}${label(node)}`,
      description: notebook
        ? [cellsText(node.size), formatBytes(node.bytes)].filter(Boolean).join(' · ')
        : t('line {0}', node.pos + 1),
      node,
    }));
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = t('Go to heading');
    qp.matchOnDescription = false;
    const active = items.find((i) => i.node === current);
    if (active) qp.activeItems = [active]; // start at the current section
    qp.onDidAccept(() => {
      const [pick] = qp.selectedItems;
      qp.hide();
      if (pick) revealHeading(pick.node, true);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  };

  /**
   * The headings a tree command should act on, in document order. VS Code
   * passes the right-clicked heading and the current multi-selection; when the
   * right-clicked heading is not part of that selection, only it counts.
   */
  const targetsOf = (node, selected) => {
    // Shortcuts in the Starred group stand for their headings; the group
    // itself is never a target.
    const real = (n) => (n && n.ref) || n;
    node = real(node);
    if (node && node.group) node = undefined;
    if (Array.isArray(selected)) selected = selected.map(real).filter((n) => n && !n.group);
    const sameNode = (a, b) => a === b || (a && b && a.id === b.id);
    const list =
      Array.isArray(selected) && selected.length && selected.some((n) => sameNode(n, node)) ? selected : node ? [node] : [];
    // After an edit the tree is rebuilt, but VS Code may still hand back the
    // old heading objects; look each one up again by id so positions are
    // current, and drop headings that no longer exist.
    const fresh = list.map((n) => (provider.byId && provider.byId.get(n.id)) || null).filter(Boolean);
    return [...new Set(fresh)].sort((a, b) => provider.flat.indexOf(a) - provider.flat.indexOf(b));
  };

  /** The merged cell (or line) ranges of the given headings' sections, in order. */
  const sectionRanges = (nodes) => mergeRanges(nodes.map((n) => sectionRange(provider.flat, n)));

  /**
   * "Select Section": select every cell (or line) of one or more headings'
   * sections in the editor and move focus there, so the user can cut, copy,
   * move, run or delete them with VS Code's own commands. Overlapping or
   * adjacent sections are merged. Nothing is changed here.
   */
  const selectSection = async (node, selected) => {
    const src = provider.source;
    const nodes = targetsOf(node, selected);
    if (!src || !nodes.length) return;
    const parts = nodes.map((n) => sectionRange(provider.flat, n));
    const ranges = mergeRanges(parts);
    lastRevealed = nodes[0];
    quietScroll();
    let count;
    if (src.kind === 'notebook') {
      if (ranges.some((r) => r.end > src.doc.cellCount)) return; // stale nodes after an edit
      const editor = await vscode.window.showNotebookDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        selections: ranges.map((r) => new vscode.NotebookRange(r.start, r.end)),
        preserveFocus: false,
      });
      editor.revealRange(new vscode.NotebookRange(ranges[0].start, ranges[0].start + 1), vscode.NotebookEditorRevealType.AtTop);
      count = cellsText(ranges.reduce((s, r) => s + r.end - r.start, 0));
    } else {
      if (ranges[0].start >= src.doc.lineCount) return;
      const editor = await vscode.window.showTextDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        preserveFocus: false,
      });
      // Whole lines, so cutting or moving a section takes its line breaks along.
      let lines = 0;
      editor.selections = ranges.map((r) => {
        const { range, lines: n } = lineRange(src.doc, r);
        lines += n;
        return new vscode.Selection(range.start, range.end);
      });
      editor.revealRange(new vscode.Range(ranges[0].start, 0, ranges[0].start, 0), vscode.TextEditorRevealType.AtTop);
      count = linesText(lines);
    }
    // Warn about a shared first cell only when it starts a selected block; a
    // cell inside a larger selected section is selected anyway.
    const shared = parts.find((p) => p.sharedWith.length && ranges.some((r) => r.start === p.start));
    const note = shared ? t(' (its first cell also holds "{0}")', truncate(shared.sharedWith[0].text, 30)) : '';
    const msg =
      nodes.length === 1
        ? t('Selected {0} of "{1}"', count, truncate(nodes[0].text, 40))
        : t('Selected {0} in {1} sections', count, nodes.length);
    vscode.window.setStatusBarMessage(`$(selection) ${msg}${note}`, 6000);
  };

  /**
   * The tag picker for a list of cells (one or many). With several cells, a
   * tag on only some of them starts unchecked and is left as is unless it is
   * checked; see nextTagsMulti() in src/tags.js. All changes are applied as
   * one undoable edit.
   *
   * @param {object[]} cells notebook cells, in order
   * @param {string} [title] picker title; defaults to "Tags for cell N"
   */
  const openTagPicker = (cells, title) => {
    const lists = cells.map(getCellTags);
    const total = cells.length;
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.title = title || t('Tags for cell {0}', cells[0].index + 1);
    qp.placeholder = t('Check tags, then OK · type to add a new one');
    qp.items = multiPickerEntries(lists).map((e) => {
      const base = e.custom ? t('custom') : t(COMMON_TAGS.find((c) => c.tag === e.tag).description);
      const partial = total > 1 && e.count > 0 && e.count < total ? t(' · {0}/{1} cells', e.count, total) : '';
      return { label: e.tag, description: base + partial, tag: e.tag, picked: e.picked };
    });
    qp.selectedItems = qp.items.filter((i) => i.picked);
    qp.onDidAccept(async () => {
      const typed = qp.value.trim();
      if (typed && !isValidTag(typed)) {
        vscode.window.showWarningMessage(t('Tags cannot contain spaces: "{0}"', typed));
        return;
      }
      const checked = qp.items.filter((i) => qp.selectedItems.includes(i)).map((i) => i.tag);
      // The typed text is a filter while it still matches offered tags (e.g.
      // "hide" to find hide-input/hide-output); it becomes a new tag only when
      // it matches none of them. An exact name means "check that tag".
      const exact = typed && qp.items.some((i) => i.tag === typed);
      const filtering = typed && !exact && qp.items.some((i) => i.tag.toLowerCase().includes(typed.toLowerCase()));
      const extra = typed && !exact && !filtering ? typed : '';
      if (exact && !checked.includes(typed)) checked.push(typed);
      const next = nextTagsMulti(lists, checked, extra);
      qp.hide();
      const changes = cells
        .map((cell, i) => ({ cell, tags: next[i], changed: next[i].join('\n') !== lists[i].join('\n') }))
        .filter((c) => c.changed);
      if (!changes.length) return;
      if (await setCellTags(changes)) {
        tagButton.refresh();
        let text;
        if (total > 1) text = t('Tags updated on {0} of {1} code cells', changes.length, total);
        else if (next[0].length) text = t('Cell {0} tags: {1}', cells[0].index + 1, next[0].join(', '));
        else text = t('Cell {0}: tags removed', cells[0].index + 1);
        vscode.window.setStatusBarMessage(`$(tag) ${text}`, 4000);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  };

  /**
   * "Edit Cell Tags": from a cell's Tags button (that cell, or every selected
   * code cell when it is part of a multi-cell selection) or from the command
   * palette (the selected cells; only code cells when several are selected).
   */
  const editCellTags = async (clicked) => {
    const fromButton = !!(clicked && clicked.notebook);
    const editor =
      vscode.window.visibleNotebookEditors.find((e) => fromButton && e.notebook === clicked.notebook) ||
      vscode.window.activeNotebookEditor;
    const selection = editor && (!fromButton || editor.notebook === clicked.notebook) ? selectedCells(editor) : [];
    let cells;
    if (fromButton) {
      // A Markdown cell's own button (shown only when it has tags) edits just that cell.
      const inSelection = selection.length > 1 && selection.some((c) => c.index === clicked.index);
      cells = isCodeCell(clicked) && inSelection ? selection : [clicked];
    } else cells = selection;
    // With several cells, only code cells are tagged: collapse tags on Markdown
    // cells would fold headings and text in Jupyter Book pages.
    if (cells.length > 1) cells = cells.filter(isCodeCell);
    if (!cells.length) {
      vscode.window.showInformationMessage(t('Notebook Headings: select a notebook cell first.'));
      return;
    }
    openTagPicker(cells, cells.length > 1 ? t('Tags for {0} selected code cells', cells.length) : undefined);
  };

  /**
   * "Edit Section Tags": right-click one or more headings in the tree to tag
   * every code cell of their sections, subsections included.
   */
  const editSectionTags = (node, selected) => {
    const src = provider.source;
    const nodes = targetsOf(node, selected);
    if (!src || src.kind !== 'notebook' || !nodes.length) return;
    const ranges = sectionRanges(nodes);
    // Only code cells: the heading and text cells stay visible on the page.
    const cells = cellsIn(src.doc, ranges).filter(isCodeCell);
    if (!cells.length) {
      vscode.window.showInformationMessage(t('Notebook Headings: this section has no code cells.'));
      return;
    }
    const count = cells.length === 1 ? t('1 code cell') : t('{0} code cells', cells.length);
    const title =
      nodes.length === 1
        ? t('Tags for "{0}" · {1}', truncate(nodes[0].text, 40), count)
        : t('Tags for {0} sections · {1}', nodes.length, count);
    openTagPicker(cells, title);
  };

  /**
   * "Clear Section Outputs": remove the outputs of every code cell in one or
   * more sections, subsections included, after a confirmation that names the
   * number of cells and bytes. Code, metadata and execution counts are kept;
   * the change is one undoable edit, like the editor's own Clear Outputs.
   * `options.confirm: false` skips the question (integration tests only).
   */
  const clearOutputs = async (node, selected, options = {}) => {
    const src = provider.source;
    const nodes = targetsOf(node, selected);
    if (!src || src.kind !== 'notebook' || !nodes.length) return;
    const cells = cellsIn(src.doc, sectionRanges(nodes)).filter((c) => isCodeCell(c) && c.outputs.length);
    if (!cells.length) {
      vscode.window.showInformationMessage(t('Notebook Headings: this section has no outputs.'));
      return;
    }
    const bytes = cells.reduce((sum, c) => sum + cellOutputBytes(c), 0);
    const what = bytes ? `${cellsText(cells.length)} (${formatBytes(bytes)})` : cellsText(cells.length);
    const where = nodes.length === 1 ? `"${truncate(nodes[0].text, 40)}"` : t('{0} sections', nodes.length);
    if (options.confirm !== false) {
      const ok = t('Clear Outputs');
      const undo = process.platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z';
      const answer = await vscode.window.showWarningMessage(
        t('Clear the outputs of {0} in {1}?', what, where),
        { modal: true, detail: t('Code is kept. Undo with {0}.', undo) },
        ok
      );
      if (answer !== ok) return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(
      src.doc.uri,
      cells.map((cell) => {
        const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
        data.metadata = cell.metadata;
        data.executionSummary = cell.executionSummary;
        data.outputs = [];
        return vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell.index, cell.index + 1), [data]);
      })
    );
    if (await vscode.workspace.applyEdit(edit)) {
      vscode.window.setStatusBarMessage(`$(clear-all) ${t('Cleared outputs of {0}', what)}`, 4000);
    }
  };

  /**
   * "Copy Section Reference": file, heading path and cell (or line) range of a
   * section, e.g. `code/Analysis.ipynb · 2  Analysis › 2.1  Summary · cells 12–30`.
   * Cell selections are not passed on to chat assistants such as Claude Code
   * (only selected text is), so pasting this tells them exactly which cells
   * are meant. Numbers are 1-based, as shown in the editor.
   */
  const sectionReference = (node) => {
    const src = provider.source;
    const file = vscode.workspace.asRelativePath(src.doc.uri, true);
    const { start, end } = sectionRange(provider.flat, node);
    const first = start + 1;
    const last = end;
    const notebook = src.kind === 'notebook';
    let range;
    if (first === last) range = notebook ? t('cell {0}', first) : t('line {0}', first);
    else range = notebook ? t('cells {0}–{1}', first, last) : t('lines {0}–{1}', first, last);
    return [file, ancestry(node).map(label).join(' › '), range].join(' · ');
  };

  /**
   * "Copy Section Content": the text of every cell (or line) of one or more
   * sections, for pasting into a chat that cannot read local files. Code
   * cells are fenced with their language; overlapping sections are merged.
   */
  const copyContent = async (node, selected) => {
    const src = provider.source;
    const nodes = targetsOf(node, selected);
    if (!src || !nodes.length) return;
    const ranges = sectionRanges(nodes);
    if (src.kind === 'notebook') {
      const blocks = cellsIn(src.doc, ranges).map((cell) => {
        const body = cell.document.getText();
        if (isMarkdownCell(cell)) return body;
        // A fence longer than any backtick run inside the code.
        const longest = (body.match(/`+/g) || []).reduce((m, run) => Math.max(m, run.length), 0);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return `${fence}${cell.document.languageId}\n${body}\n${fence}`;
      });
      await copy(blocks.join('\n\n'), t('Copied {0}', cellsText(blocks.length)));
    } else {
      let lines = 0;
      const parts = ranges.map((r) => {
        const { range, lines: n } = lineRange(src.doc, r);
        lines += n;
        return src.doc.getText(range).replace(/\n+$/, ''); // no trailing blank lines
      });
      await copy(parts.join('\n\n'), t('Copied {0}', linesText(lines)));
    }
  };

  // --- marks: status and star -----------------------------------------------------------

  /**
   * Write a mark change to the project's marks file (see MarksFile), then
   * redraw the tree right away. The document itself is not changed, except
   * that marks saved in a notebook's cells by version 1.5 are moved out of
   * the cells this change touches.
   *
   * @param {object[]} nodes
   * @param {{ status?: string|null, star?: boolean }} patch see updateMarks()
   */
  const setMarks = async (nodes, patch) => {
    const src = provider.source;
    if (!src || !nodes.length) return false;
    const texts = provider.flat.map((h) => h.text);
    // Start from the marks shown now, minus those still in the metadata of
    // cells this change does not touch: they stay there until one of their
    // cell's marks changes, so a notebook is edited only when needed.
    const touched = new Set(nodes.map((n) => n.pos));
    let marks = {};
    for (const [i, mark] of Object.entries(provider.marks)) {
      if (!provider.legacy.has(Number(i)) || touched.has(provider.flat[i].pos)) marks[i] = mark;
    }
    for (const n of nodes) marks = updateMarks(marks, texts, n.slot, patch);
    try {
      await marksFile.set(src.doc.uri, marks);
    } catch (err) {
      vscode.window.showErrorMessage(t('Notebook Headings: could not save the marks ({0}).', err.message));
      return false;
    }
    // Version 1.5 marks of the touched cells now live in the file: remove
    // them from the cells (one undoable notebook edit).
    if (src.kind === 'notebook') {
      const cells = [...touched]
        .filter((pos) => pos < src.doc.cellCount && [...provider.legacy].some((i) => provider.flat[i].pos === pos))
        .map((pos) => src.doc.cellAt(pos));
      const changes = cells.map((cell) => {
        const meta = JSON.parse(JSON.stringify(jupyterMetaOf(cell)));
        delete meta[MARKS_KEY];
        return [cell, meta];
      });
      if (changes.length) await setJupyterMetadata(changes);
    }
    scheduleRebuild.cancel();
    provider.rebuild();
    return true;
  };

  const headingsText = (nodes) =>
    nodes.length === 1 ? `"${truncate(nodes[0].text, 40)}"` : t('{0} headings', nodes.length);

  /** "Set Status…": TODO, In progress, To check, Finished, or clear. */
  const setStatus = async (node, selected) => {
    const src = provider.source;
    const nodes = targetsOf(node, selected);
    if (!src || !nodes.length) return;
    const same = nodes.every((n) => n.status === nodes[0].status) ? nodes[0].status : undefined;
    const items = STATUSES.map((st) => ({
      label: `$(${st.icon}) ${t(st.label)}`,
      description: st.id === same ? t('current') : '',
      id: st.id,
    }));
    items.push({ label: `$(close) ${t('Clear Status')}`, description: '', id: null });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Status of {0}', headingsText(nodes)) });
    if (!pick) return;
    if (!(await setMarks(nodes, { status: pick.id }))) return;
    const after = nodes.map((n) => provider.byId.get(n.id)).filter(Boolean);
    if (pick.id === null && after.some((n) => n.autoStatus)) {
      vscode.window.showInformationMessage(
        t('Notebook Headings: a heading whose text contains an in-progress marker (such as ???) still shows as in progress. Remove the marker from the text, or set the status to Finished.')
      );
    }
  };

  /** "Add Star" / "Remove Star". */
  const setStar = (on) => async (node, selected) => {
    const nodes = targetsOf(node, selected);
    if (!nodes.length) return;
    if (await setMarks(nodes, { star: on })) {
      const msg = on ? t('Starred {0}', headingsText(nodes)) : t('Removed star from {0}', headingsText(nodes));
      vscode.window.setStatusBarMessage(`$(star-${on ? 'full' : 'empty'}) ${msg}`, 3000);
    }
  };

  /** Copy to the clipboard with a short status bar confirmation. */
  const copy = async (text, message) => {
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    const shown = message || t('Copied: {0}', truncate(text.replace(/\n/g, ' · '), 60));
    vscode.window.setStatusBarMessage(`$(check) ${shown}`, 2500);
  };

  // --- wiring ---------------------------------------------------------------------------

  const marksWatcher = vscode.workspace.createFileSystemWatcher(`**/${MARKS_FILE.split(path.sep).join('/')}`);
  const onMarksFileChange = () => {
    if (provider.source) scheduleRebuild();
  };

  context.subscriptions.push(
    view,
    status,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', tagButton),

    // Remember what the user expands/collapses (ignored while filtering,
    // where everything is expanded by design).
    view.onDidExpandElement((e) => provider.filtering || provider.expanded.set(e.element.id, true)),
    view.onDidCollapseElement((e) => provider.filtering || provider.expanded.set(e.element.id, false)),
    view.onDidChangeVisibility((e) => {
      lastRevealed = undefined;
      if (e.visible) follow(cursorPos(provider.source));
    }),

    // Which document to show.
    vscode.window.onDidChangeActiveNotebookEditor(track),
    vscode.window.onDidChangeActiveTextEditor(track),
    vscode.window.onDidChangeVisibleNotebookEditors(track),
    vscode.window.onDidChangeVisibleTextEditors(track),

    // Cursor and scroll position.
    vscode.window.onDidChangeNotebookEditorSelection((e) => {
      if (isSourceDoc(e.notebookEditor.notebook) && e.selections.length) onCursor(e.selections[0].start);
    }),
    vscode.window.onDidChangeNotebookEditorVisibleRanges((e) => {
      if (isSourceDoc(e.notebookEditor.notebook) && e.visibleRanges.length) onScroll(e.visibleRanges[0].start);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (isSourceDoc(e.textEditor.document) && e.selections.length) onCursor(e.selections[0].active.line);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (isSourceDoc(e.textEditor.document) && e.visibleRanges.length) onScroll(e.visibleRanges[0].start.line);
    }),

    // Edits.
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      // Tags changed by undo/redo, another extension or a reverted file:
      // redraw the Tags buttons so their counts stay right.
      if (e.cellChanges.some((c) => c.metadata)) tagButton.refresh();
      if (isSourceDoc(e.notebook)) scheduleRebuild();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isSourceDoc(e.document)) scheduleRebuild();
    }),

    // Marks live in .vscode/notebook-headings.json: move them along with
    // renamed documents, and redraw when that file changes on disk (another
    // window, a git pull, a sync service).
    vscode.workspace.onDidRenameFiles(async (e) => {
      await marksFile.rename(e.files).catch(() => {});
      if (provider.source) scheduleRebuild();
    }),
    vscode.workspace.onDidDeleteFiles((e) => marksFile.forget(e.files).catch(() => {})),
    marksWatcher,
    marksWatcher.onDidChange(onMarksFileChange),
    marksWatcher.onDidCreate(onMarksFileChange),
    marksWatcher.onDidDelete(onMarksFileChange),

    // Settings. Changing the default level resets expansion; anything else
    // redraws while keeping what the user has expanded.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('notebookHeadings')) return;
      settingsCache = undefined;
      if (e.affectsConfiguration('notebookHeadings.cellTagButton')) tagButton.refresh();
      if (e.affectsConfiguration('notebookHeadings.markdown')) track();
      if (e.affectsConfiguration('notebookHeadings.defaultExpandLevel')) {
        provider.resetExpansion();
      } else {
        decorations.refresh();
        provider.rebuild();
      }
      onPosition(cursorPos(provider.source));
    }),

    // Commands (titles, icons, menus and keybindings are in package.json).
    vscode.commands.registerCommand('notebookHeadings.reveal', (node) => revealHeading(node)),
    vscode.commands.registerCommand('notebookHeadings.quickJump', quickJump),
    vscode.commands.registerCommand('notebookHeadings.filter', promptFilter),
    vscode.commands.registerCommand('notebookHeadings.clearFilter', () => setFilter('')),
    vscode.commands.registerCommand('notebookHeadings.toggleNumbering', () =>
      config().update('numbering', !setting('numbering', true), vscode.ConfigurationTarget.Global)
    ),
    vscode.commands.registerCommand('notebookHeadings.resetExpansion', () => {
      lastRevealed = undefined;
      provider.resetExpansion();
    }),
    vscode.commands.registerCommand('notebookHeadings.selectSection', selectSection),
    vscode.commands.registerCommand('notebookHeadings.editCellTags', editCellTags),
    vscode.commands.registerCommand('notebookHeadings.editSectionTags', editSectionTags),
    // With several headings selected, copy one line per heading.
    vscode.commands.registerCommand('notebookHeadings.copyTitle', (node, selected) =>
      copy(targetsOf(node, selected).map((n) => n.text).join('\n'))
    ),
    vscode.commands.registerCommand('notebookHeadings.copyReference', (node, selected) =>
      copy(targetsOf(node, selected).map(sectionReference).join('\n'))
    ),
    vscode.commands.registerCommand('notebookHeadings.copyContent', copyContent),
    vscode.commands.registerCommand('notebookHeadings.clearOutputs', clearOutputs),
    vscode.commands.registerCommand('notebookHeadings.setStatus', setStatus),
    vscode.commands.registerCommand('notebookHeadings.addStar', setStar(true)),
    vscode.commands.registerCommand('notebookHeadings.removeStar', setStar(false)),
    vscode.commands.registerCommand('notebookHeadings.showMarked', showMarked),

    // Pending timers must not fire after deactivation.
    { dispose: () => (scheduleRebuild.cancel(), onScroll.cancel(), liveFilter.cancel()) }
  );

  // Pick up an editor that was already open when the extension activated.
  track();
  updateFilterUi();

  // Internals for the integration tests in test/integration/ (not an API).
  return { __test: { provider, view, status, marksFile, revealHeading, setMarks, clearOutputs, fixGitIgnore } };
}

function deactivate() {}

module.exports = { activate, deactivate };
