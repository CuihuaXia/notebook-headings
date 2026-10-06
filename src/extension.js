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
 *   - offer a "Tags" button on notebook code cells for editing their tags.
 *
 * The only change ever made to a document is a cell's tags, and only when
 * the user edits them in the tag picker (undoable with Cmd+Z). Code, text and
 * outputs are never touched.
 */
'use strict';

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

/** Settings under the `notebookHeadings.` prefix (see package.json). */
const config = () => vscode.workspace.getConfiguration('notebookHeadings');

/** Theme color id for a rank, e.g. `notebookHeadings.level1Foreground`. */
const rankColor = (rank) => new vscode.ThemeColor(`notebookHeadings.level${rank}Foreground`);

/** Label of a node honoring the `numbering` setting. */
const label = (node) => labelOf(node, config().get('numbering', true));

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
  config().get('markdown', true);

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

/**
 * Headings and size (cell or line count) of a source's document, plus the
 * output size of every cell for notebooks.
 */
function readSource(source) {
  if (source.kind === 'notebook') {
    const nb = source.doc;
    const cells = [];
    const cellBytes = [];
    for (let i = 0; i < nb.cellCount; i++) {
      const cell = nb.cellAt(i);
      const isMarkdown = cell.kind === vscode.NotebookCellKind.Markup;
      // Only Markdown cells are parsed, so code cell text is never read.
      cells.push({ isMarkdown, text: isMarkdown ? cell.document.getText() : '' });
      cellBytes.push(cellOutputBytes(cell));
    }
    return { headings: parseNotebookHeadings(cells), total: nb.cellCount, cellBytes };
  }
  return { headings: parseMarkdownHeadings(source.doc.getText()), total: source.doc.lineCount };
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

/** A notebook cell's current tags (a copy). */
function getCellTags(cell) {
  const md = cell.metadata || {};
  const tags = useCustomMetadata() ? md.custom && md.custom.metadata && md.custom.metadata.tags : md.metadata && md.metadata.tags;
  return Array.isArray(tags) ? [...tags] : [];
}

/** A cell's metadata with its tags replaced; everything else is kept. */
function metadataWithTags(cell, tags) {
  const md = JSON.parse(JSON.stringify(cell.metadata || {}));
  const holder = useCustomMetadata() ? ((md.custom = md.custom || {}), md.custom) : md;
  holder.metadata = holder.metadata || {};
  if (tags.length) holder.metadata.tags = tags;
  else delete holder.metadata.tags;
  return sortKeysDeep(md);
}

/**
 * Replace the tags of one or more cells of a notebook in a single
 * WorkspaceEdit, so one Cmd+Z undoes the whole change.
 *
 * @param {{ cell: object, tags: string[] }[]} changes
 */
async function setCellTags(changes) {
  if (!changes.length) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.set(
    changes[0].cell.notebook.uri,
    changes.map(({ cell, tags }) => vscode.NotebookEdit.updateCellMetadata(cell.index, metadataWithTags(cell, tags)))
  );
  return vscode.workspace.applyEdit(edit);
}

/** Whether a notebook cell is a code cell (not Markdown). */
const isCodeCell = (cell) => cell.kind === vscode.NotebookCellKind.Code;

/** Cells covered by a notebook editor's selections, in order, without repeats. */
function selectedCells(editor) {
  if (!editor) return [];
  const seen = new Set();
  const cells = [];
  for (const r of editor.selections || (editor.selection ? [editor.selection] : [])) {
    for (let i = r.start; i < Math.min(r.end, editor.notebook.cellCount); i++) {
      if (!seen.has(i)) seen.add(i), cells.push(editor.notebook.cellAt(i));
    }
  }
  return cells.sort((a, b) => a.index - b.index);
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
    if (!config().get('cellTagButton', true)) return [];
    const tags = getCellTags(cell);
    // The offered tags collapse code and outputs, so the button belongs on code
    // cells; a Markdown cell shows it only when it already has tags to edit.
    if (cell.kind !== vscode.NotebookCellKind.Code && !tags.length) return [];
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
    if (uri.scheme !== DECO_SCHEME || !config().get('levelColors', true)) return undefined;
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
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.source = undefined;
    this.roots = [];
    this.flat = [];
    /** tree item id -> heading node, rebuilt with the tree */
    this.byId = new Map();
    this.filter = '';
    /** document uri -> counter bumped by "Collapse to Default Level" */
    this.generations = new Map();
    /** tree item id -> expansion chosen by the user (overrides the default) */
    this.expanded = new Map();
  }

  setSource(source) {
    this.source = source;
    // Lets package.json show notebook-only menu items (Edit Section Tags).
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

  setFilter(query) {
    this.filter = query.trim();
    applyFilter(this.roots, this.filter);
    this._onDidChange.fire();
  }

  /** Re-read the source document and redraw the whole tree. */
  rebuild() {
    const src = this.source;
    if (!src) {
      this.roots = [];
      this.flat = [];
      this.byId = new Map();
    } else {
      const uri = src.doc.uri.toString();
      const prefix = `${SESSION}|${this.generations.get(uri) || 0}|${uri}|`;
      const { headings, total, cellBytes } = readSource(src);
      ({ roots: this.roots, flat: this.flat } = buildTree(headings, prefix, total));
      this.byId = new Map(this.flat.map((n) => [n.id, n]));
      if (cellBytes) assignOutputSizes(this.flat, cellBytes);
      assignNumbers(this.roots, config().get('numberH1', false));
      assignColorRanks(this.flat);
      applyFilter(this.roots, this.filter);
    }
    this._onDidChange.fire();
  }

  /**
   * Whether the tree currently shows this node's children: always while a
   * filter is active, otherwise the user's choice, otherwise the default
   * (expanded when shallower than `defaultExpandLevel`).
   */
  isExpanded(node) {
    if (!node.children.length) return false;
    if (this.filter) return true;
    const chosen = this.expanded.get(node.id);
    return chosen !== undefined ? chosen : node.level < config().get('defaultExpandLevel', 2);
  }

  /**
   * The node to highlight for a document position: the section containing
   * it, or — if that section is hidden inside a collapsed parent — the
   * deepest ancestor that is currently visible. Following the cursor thus
   * never expands the tree on its own.
   */
  visibleHeadingAt(pos) {
    const node = headingAt(this.flat, pos);
    if (!node || !node.visible) return undefined;
    for (const n of ancestry(node)) {
      if (n === node || !this.isExpanded(n)) return n;
    }
    return node;
  }

  // --- TreeDataProvider interface ---------------------------------------------

  getChildren(node) {
    const list = node ? node.children : this.roots;
    return this.filter ? list.filter((n) => n.visible) : list;
  }

  /** Required by TreeView.reveal(). */
  getParent(node) {
    return node.parent && node.parent.level > 0 ? node.parent : undefined;
  }

  getTreeItem(node) {
    const text = label(node);
    const treeLabel = { label: text };
    if (node.matchAt >= 0) {
      // The match index is relative to node.text; shift past the number prefix.
      const start = text.length - node.text.length + node.matchAt;
      treeLabel.highlights = [[start, start + this.filter.length]];
    }

    let state = vscode.TreeItemCollapsibleState.None;
    if (this.getChildren(node).length) {
      state = this.isExpanded(node)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    }

    const item = new vscode.TreeItem(treeLabel, state);
    // Filtered views get their own ids so their all-expanded state never
    // leaks into the normal tree.
    item.id = this.filter ? `${node.id}|filter:${this.filter}` : node.id;

    const notebook = this.source && this.source.kind === 'notebook';
    const size = notebook ? formatBytes(node.bytes) : '';
    item.tooltip =
      `${'#'.repeat(node.level)} ${node.text}\n` +
      (notebook ? cellsText(node.size) : t('line {0}', node.pos + 1)) +
      (size ? `\n${t('outputs: {0}', size)}` : '');
    if (notebook) {
      // e.g. "34 · 2.1 MB": cell count and/or output size, as configured.
      const parts = [];
      if (config().get('showCellCount', true)) parts.push(`${node.size}`);
      if (size && config().get('showOutputSize', true)) parts.push(size);
      if (parts.length) item.description = parts.join(' · ');
    }

    if (config().get('levelColors', true)) {
      if (node.rank) {
        item.resourceUri = vscode.Uri.from({
          scheme: DECO_SCHEME,
          // Must not start with "//" (invalid without an authority).
          path: `/level${node.rank}`,
          query: `rank=${node.rank}`,
        });
      }
      // An explicit icon keeps VS Code from showing a file-type icon for the
      // resource URI; the title gets one too so all levels indent equally.
      item.iconPath = new vscode.ThemeIcon(RANK_ICONS[node.rank], node.rank ? rankColor(node.rank) : undefined);
    }

    item.command = { command: 'notebookHeadings.reveal', title: 'Go to Heading', arguments: [node] };
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
  const provider = new HeadingsProvider();
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

  /** Show the exact section of `pos` in the status bar. */
  const updateStatus = (pos) => {
    const node = pos === undefined ? undefined : headingAt(provider.flat, pos);
    if (!node || !config().get('statusBar', true)) return status.hide();
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
    if (pos === undefined || !view.visible || !config().get('followCursor', true)) return;
    // Don't replace a multi-selection the user built in the tree because of a
    // scroll or an edit; once they move the cursor in the editor themselves,
    // following resumes.
    const multi = view.selection && view.selection.length > 1;
    if (!userMoved && multi) return;
    const node = provider.visibleHeadingAt(pos);
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
  /** Scrolling fires many events; only react once it settles. */
  const onScroll = debounce((pos) => {
    if (Date.now() < ignoreScrollUntil) updateStatus(pos);
    else onPosition(pos);
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
    if (next) provider.setSource(next);
    else if (!isVisible(cur)) provider.setSource(undefined);
    else return;
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
    view.description = q ? `"${q}" · ${matches === 1 ? t('1 match') : t('{0} matches', matches)}` : undefined;
    vscode.commands.executeCommand('setContext', 'notebookHeadings.filtering', !!q);
  };

  const setFilter = (q) => {
    provider.setFilter(q);
    lastRevealed = undefined;
    updateFilterUi();
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
    quietScroll();
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
      label: `${' '.repeat(ancestry(node).length - 1)}$(${RANK_ICONS[node.rank]}) ${label(node)}`,
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
    const sameNode = (a, b) => a === b || (a && b && a.id === b.id);
    const list =
      Array.isArray(selected) && selected.length && selected.some((n) => sameNode(n, node)) ? selected : node ? [node] : [];
    // After an edit the tree is rebuilt, but VS Code may still hand back the
    // old heading objects; look each one up again by id so positions are
    // current, and drop headings that no longer exist.
    const fresh = list.map((n) => (provider.byId && provider.byId.get(n.id)) || null).filter(Boolean);
    return [...new Set(fresh)].sort((a, b) => provider.flat.indexOf(a) - provider.flat.indexOf(b));
  };

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
      // Each range ends at the start of the next section's line, or at the
      // very end of the file, so the selections cover whole lines.
      let lines = 0;
      editor.selections = ranges.map((r) => {
        const last = Math.min(r.end, src.doc.lineCount);
        lines += last - r.start;
        const to = last < src.doc.lineCount ? new vscode.Position(last, 0) : src.doc.lineAt(last - 1).range.end;
        return new vscode.Selection(new vscode.Position(r.start, 0), to);
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
    const ranges = mergeRanges(nodes.map((n) => sectionRange(provider.flat, n)));
    // Only code cells: the heading and text cells stay visible on the page.
    const cells = [];
    for (const r of ranges) {
      for (let i = r.start; i < Math.min(r.end, src.doc.cellCount); i++) {
        const cell = src.doc.cellAt(i);
        if (isCodeCell(cell)) cells.push(cell);
      }
    }
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

  /** Copy to the clipboard with a short status bar confirmation. */
  const copy = async (text) => {
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(check) ${t('Copied: {0}', truncate(text.replace(/\n/g, ' · '), 60))}`, 2500);
  };

  // --- wiring ---------------------------------------------------------------------------

  context.subscriptions.push(
    view,
    status,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', tagButton),

    // Remember what the user expands/collapses (ignored while filtering,
    // where everything is expanded by design).
    view.onDidExpandElement((e) => provider.filter || provider.expanded.set(e.element.id, true)),
    view.onDidCollapseElement((e) => provider.filter || provider.expanded.set(e.element.id, false)),
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

    // Settings. Changing the default level resets expansion; anything else
    // redraws while keeping what the user has expanded.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('notebookHeadings')) return;
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
      config().update('numbering', !config().get('numbering', true), vscode.ConfigurationTarget.Global)
    ),
    vscode.commands.registerCommand('notebookHeadings.resetExpansion', () => {
      lastRevealed = undefined;
      provider.resetExpansion();
    }),
    vscode.commands.registerCommand('notebookHeadings.refresh', () => provider.rebuild()),
    vscode.commands.registerCommand('notebookHeadings.selectSection', selectSection),
    vscode.commands.registerCommand('notebookHeadings.editCellTags', editCellTags),
    vscode.commands.registerCommand('notebookHeadings.editSectionTags', editSectionTags),
    // With several headings selected, copy one line per heading.
    vscode.commands.registerCommand('notebookHeadings.copyTitle', (node, selected) =>
      copy(targetsOf(node, selected).map((n) => n.text).join('\n'))
    ),
    vscode.commands.registerCommand('notebookHeadings.copyPath', (node, selected) =>
      copy(targetsOf(node, selected).map((n) => ancestry(n).map(label).join(' › ')).join('\n'))
    ),

    // Pending timers must not fire after deactivation.
    { dispose: () => (scheduleRebuild.cancel(), onScroll.cancel(), liveFilter.cancel()) }
  );

  // Pick up an editor that was already open when the extension activated.
  track();
  updateFilterUi();
}

function deactivate() {}

module.exports = { activate, deactivate };
