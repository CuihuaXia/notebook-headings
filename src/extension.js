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
 *   - provide the commands contributed in package.json.
 *
 * Nothing here ever modifies a document.
 */
'use strict';

const vscode = require('vscode');
const {
  parseNotebookHeadings,
  parseMarkdownHeadings,
  buildTree,
  assignNumbers,
  assignColorRanks,
  applyFilter,
  headingAt,
  sectionRange,
  ancestry,
  labelOf,
} = require('./headings');

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

/** Headings and size (cell or line count) of a source's document. */
function readSource(source) {
  if (source.kind === 'notebook') {
    const nb = source.doc;
    const cells = [];
    for (let i = 0; i < nb.cellCount; i++) {
      const cell = nb.cellAt(i);
      const isMarkdown = cell.kind === vscode.NotebookCellKind.Markup;
      // Only Markdown cells are parsed, so code cell text is never read.
      cells.push({ isMarkdown, text: isMarkdown ? cell.document.getText() : '' });
    }
    return { headings: parseNotebookHeadings(cells), total: nb.cellCount };
  }
  return { headings: parseMarkdownHeadings(source.doc.getText()), total: source.doc.lineCount };
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
    this.filter = '';
    /** document uri -> counter bumped by "Collapse to Default Level" */
    this.generations = new Map();
    /** tree item id -> expansion chosen by the user (overrides the default) */
    this.expanded = new Map();
  }

  setSource(source) {
    this.source = source;
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
    } else {
      const uri = src.doc.uri.toString();
      const prefix = `${SESSION}|${this.generations.get(uri) || 0}|${uri}|`;
      const { headings, total } = readSource(src);
      ({ roots: this.roots, flat: this.flat } = buildTree(headings, prefix, total));
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
    item.tooltip =
      `${'#'.repeat(node.level)} ${node.text}\n` +
      (notebook ? `${node.size} cell${node.size > 1 ? 's' : ''}` : `line ${node.pos + 1}`);
    if (notebook && config().get('showCellCount', true)) item.description = `${node.size}`;

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
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const status = vscode.window.createStatusBarItem('notebookHeadings.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Notebook Headings: Current Section';
  status.command = `${VIEW_ID}.focus`; // auto-generated "focus this view" command

  // --- following the cursor: status bar + tree highlight ----------------------

  /** Last node revealed in the tree; avoids re-revealing on every event. */
  let lastRevealed;

  /** Show the exact section of `pos` in the status bar. */
  const updateStatus = (pos) => {
    const node = pos === undefined ? undefined : headingAt(provider.flat, pos);
    if (!node || !config().get('statusBar', true)) return status.hide();
    status.text = `$(list-tree) ${truncate(label(node), 48)}`;
    status.tooltip = ancestry(node).map(label).join('  ›  ') + '\n\nClick to show the headings view';
    status.show();
  };

  /** Select the section of `pos` in the tree (or its visible ancestor). */
  const follow = (pos) => {
    if (pos === undefined || !view.visible || !config().get('followCursor', true)) return;
    const node = provider.visibleHeadingAt(pos);
    if (!node || node === lastRevealed) return;
    lastRevealed = node;
    // focus: false keeps keyboard focus in the editor; expand: false never
    // opens collapsed sections. Errors (e.g. a stale node) are harmless.
    view.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {});
  };

  const onPosition = (pos) => {
    updateStatus(pos);
    follow(pos);
  };
  /** Scrolling fires many events; only react once it settles. */
  const onScroll = debounce(onPosition, 150);

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
    view.description = q ? `"${q}" · ${matches} match${matches === 1 ? '' : 'es'}` : undefined;
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
    box.placeholder = 'Filter headings (Enter to keep, Esc to cancel)';
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
    if (!src) return;
    lastRevealed = node;
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
      vscode.window.showInformationMessage('Notebook Headings: no headings in the current editor.');
      return;
    }
    const notebook = provider.source.kind === 'notebook';
    const current = headingAt(provider.flat, cursorPos(provider.source));
    const items = provider.flat.map((node) => ({
      // Em spaces indent by depth; $(icon) renders the level shape.
      label: `${' '.repeat(ancestry(node).length - 1)}$(${RANK_ICONS[node.rank]}) ${label(node)}`,
      description: notebook ? `${node.size} cell${node.size > 1 ? 's' : ''}` : `line ${node.pos + 1}`,
      node,
    }));
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = 'Go to heading';
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
   * "Select Section": select every cell (or line) of a heading's section in
   * the editor and move focus there, so the user can cut, copy, move, run or
   * delete it with VS Code's own commands. Nothing is changed here.
   */
  const selectSection = async (node) => {
    const src = provider.source;
    if (!src || !node) return;
    const { start, end, sharedWith } = sectionRange(provider.flat, node);
    lastRevealed = node;
    let what;
    if (src.kind === 'notebook') {
      if (end > src.doc.cellCount) return; // stale node after an edit
      const range = new vscode.NotebookRange(start, end);
      const editor = await vscode.window.showNotebookDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        selections: [range],
        preserveFocus: false,
      });
      editor.revealRange(new vscode.NotebookRange(start, start + 1), vscode.NotebookEditorRevealType.AtTop);
      what = `${end - start} cell${end - start > 1 ? 's' : ''}`;
    } else {
      if (start >= src.doc.lineCount) return;
      const editor = await vscode.window.showTextDocument(src.doc, {
        viewColumn: src.editor.viewColumn,
        preserveFocus: false,
      });
      // End at the start of the next section's line, or at the very end of
      // the file, so the selection covers whole lines.
      const last = Math.min(end, src.doc.lineCount);
      const to = last < src.doc.lineCount ? new vscode.Position(last, 0) : src.doc.lineAt(last - 1).range.end;
      editor.selection = new vscode.Selection(new vscode.Position(start, 0), to);
      editor.revealRange(new vscode.Range(start, 0, start, 0), vscode.TextEditorRevealType.AtTop);
      what = `${last - start} line${last - start > 1 ? 's' : ''}`;
    }
    const shared = sharedWith.length
      ? ` (its first cell also holds "${truncate(sharedWith[0].text, 30)}")`
      : '';
    vscode.window.setStatusBarMessage(`$(selection) Selected ${what} of "${truncate(node.text, 40)}"${shared}`, 6000);
  };

  /** Copy to the clipboard with a short status bar confirmation. */
  const copy = async (text) => {
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(check) Copied: ${truncate(text, 60)}`, 2500);
  };

  // --- wiring ---------------------------------------------------------------------------

  context.subscriptions.push(
    view,
    status,
    vscode.window.registerFileDecorationProvider(decorations),

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
      if (isSourceDoc(e.notebookEditor.notebook) && e.selections.length) onPosition(e.selections[0].start);
    }),
    vscode.window.onDidChangeNotebookEditorVisibleRanges((e) => {
      if (isSourceDoc(e.notebookEditor.notebook) && e.visibleRanges.length) onScroll(e.visibleRanges[0].start);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (isSourceDoc(e.textEditor.document) && e.selections.length) onPosition(e.selections[0].active.line);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (isSourceDoc(e.textEditor.document) && e.visibleRanges.length) onScroll(e.visibleRanges[0].start.line);
    }),

    // Edits.
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (isSourceDoc(e.notebook)) scheduleRebuild();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isSourceDoc(e.document)) scheduleRebuild();
    }),

    // Settings. Changing the default level resets expansion; anything else
    // redraws while keeping what the user has expanded.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('notebookHeadings')) return;
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
    vscode.commands.registerCommand('notebookHeadings.copyTitle', (node) => copy(node && node.text)),
    vscode.commands.registerCommand('notebookHeadings.copyPath', (node) =>
      copy(node && ancestry(node).map(label).join(' › '))
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
