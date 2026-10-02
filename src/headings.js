/**
 * headings.js — the pure logic of Notebook Headings.
 *
 * Everything in this file works on plain JavaScript data and has no
 * dependency on the `vscode` module, so it can be unit-tested with plain
 * Node (`npm test`). The VS Code side (src/extension.js) turns notebooks and
 * Markdown documents into plain inputs, calls these functions, and renders
 * the resulting tree.
 *
 * Data flow:
 *
 *   document text ──scanHeadings──▶ [{ level, text, pos }]   (flat headings)
 *                 ──buildTree────▶ { roots, flat }            (nested nodes)
 *                 ──assignNumbers / assignColorRanks / applyFilter
 *                                 ▶ nodes annotated for display
 *
 * A "node" is a heading plus tree bookkeeping:
 *
 *   {
 *     level:    1..6     number of `#` characters
 *     text:     string   heading text with inline Markdown stripped
 *     pos:      number   cell index (notebook) or line index (Markdown)
 *     parent:   node     the enclosing heading (a synthetic root at the top)
 *     children: node[]
 *     key:      string   stable path key, e.g. "/Title#0/Intro#0"
 *     id:       string   idPrefix + key, used as the VS Code tree item id
 *     size:     number   cells/lines until the next heading of the same or
 *                        a shallower level
 *     number:   string   outline number such as "1.3.2" ('' = unnumbered)
 *     rank:     0..6     color/icon rank (0 = page title)
 *     visible:  boolean  survives the current filter
 *     matchAt:  number   index of the filter match in `text`, or -1
 *   }
 */
'use strict';

/**
 * An ATX heading: up to three spaces of indentation, 1–6 `#`, at least one
 * space or tab, the text, and an optional closing run of `#`. (Four or more
 * spaces of indentation is an indented code block in CommonMark, so those
 * lines are deliberately not matched.)
 */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Opening or closing line of a fenced code block (``` or ~~~, 3 or more). */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Closing line of a YAML front matter block. */
const FRONT_MATTER_END_RE = /^(---|\.\.\.)\s*$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strip the most common inline Markdown so tree labels read cleanly:
 * links and images keep their text, bold/italic markers and code backticks
 * are dropped, and inline HTML tags are removed.
 *
 * @param {string} s raw heading text
 * @returns {string}
 */
function cleanText(s) {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) and ![alt](src)
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // **bold** and __bold__
    .replace(/`([^`]*)`/g, '$1') // `code`
    .replace(/<[^>]+>/g, '') // <span>…</span>
    .trim();
}

/**
 * Find every ATX heading in a block of Markdown text.
 *
 * Lines inside fenced code blocks are skipped, so `# comment` lines in a
 * ```bash or ```r block are not mistaken for headings. A fence only closes
 * on the same character it was opened with (``` vs ~~~).
 *
 * @param {string} text Markdown source
 * @param {(level: number, text: string, line: number) => void} onHeading
 *        called once per heading, in document order
 * @param {{ frontMatter?: boolean }} [options]
 *        frontMatter: skip a leading YAML block delimited by `---`
 *        (as used by MyST / Jupyter Book pages)
 */
function scanHeadings(text, onHeading, { frontMatter = false } = {}) {
  const lines = text.split(/\r?\n/);
  let fence = null; // '`' or '~' while inside a fenced code block
  let start = 0;

  if (frontMatter && lines[0] !== undefined && lines[0].trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_END_RE.test(l));
    if (end > 0) start = end + 1; // an unterminated block is treated as content
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(FENCE_RE);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(HEADING_RE);
    if (m) onHeading(m[1].length, cleanText(m[2]), i);
  }
}

/**
 * Headings of a notebook. Only Markdown cells are scanned; a heading's
 * position is the index of the cell that contains it.
 *
 * @param {{ isMarkdown: boolean, text: string }[]} cells all cells, in order
 * @returns {{ level: number, text: string, pos: number }[]}
 */
function parseNotebookHeadings(cells) {
  const headings = [];
  cells.forEach((cell, index) => {
    if (!cell.isMarkdown) return;
    scanHeadings(cell.text, (level, text) => headings.push({ level, text, pos: index }));
  });
  return headings;
}

/**
 * Headings of a Markdown file; a heading's position is its 0-based line.
 * A leading YAML front matter block is ignored.
 *
 * @param {string} text file contents
 * @returns {{ level: number, text: string, pos: number }[]}
 */
function parseMarkdownHeadings(text) {
  const headings = [];
  scanHeadings(text, (level, t, line) => headings.push({ level, text: t, pos: line }), { frontMatter: true });
  return headings;
}

// ---------------------------------------------------------------------------
// Tree construction and annotation
// ---------------------------------------------------------------------------

/**
 * Nest a flat heading list into a tree by level.
 *
 * Each heading becomes a child of the closest preceding heading with a
 * smaller level, so skipped levels are tolerated (a `####` directly under a
 * `##` simply becomes its child).
 *
 * Node keys are built from the ancestor path plus the occurrence count of
 * the same text among siblings. They therefore stay the same when unrelated
 * parts of the document are edited, which lets VS Code keep each node's
 * expanded/collapsed state across refreshes.
 *
 * @param {{ level: number, text: string, pos: number }[]} headings in document order
 * @param {string} idPrefix prepended to every key to form the node id
 * @param {number} total cell count (notebook) or line count (Markdown);
 *        the last section of each level runs to this position
 * @returns {{ roots: object[], flat: object[] }} top-level nodes, and all
 *          nodes in document order
 */
function buildTree(headings, idPrefix, total) {
  const root = { children: [], level: 0, key: '' };
  const stack = [root]; // the chain of currently open headings
  const flat = [];

  for (const h of headings) {
    while (stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    const dup = parent.children.filter((c) => c.text === h.text).length;
    const node = { ...h, parent, children: [], key: `${parent.key}/${h.text}#${dup}` };
    node.id = idPrefix + node.key;
    parent.children.push(node);
    stack.push(node);
    flat.push(node);
  }

  // Section size: from this heading to the next heading of the same or a
  // shallower level (or the end of the document). A cell holding several
  // headings still counts as one cell for each of them.
  for (let i = 0; i < flat.length; i++) {
    let end = total;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].level <= flat[i].level) {
        end = flat[j].pos;
        break;
      }
    }
    flat[i].size = Math.max(1, end - flat[i].pos);
  }

  return { roots: root.children, flat };
}

/**
 * Attach outline numbers ("1", "1.2", "1.2.3", …) to every node.
 *
 * With `numberH1` off (the default), level-1 headings are treated as page
 * titles: they get no number, and the children of all of them share one
 * running sequence. A notebook with a single `# Title` therefore numbers its
 * `##` headings 1, 2, 3 instead of 1.1, 1.2, 1.3.
 *
 * @param {object[]} roots top-level nodes from buildTree
 * @param {boolean} numberH1 also number `#` headings
 */
function assignNumbers(roots, numberH1) {
  const walk = (list, prefix, counter) => {
    for (const node of list) {
      if (node.level === 1 && !numberH1) {
        node.number = '';
        walk(node.children, '', counter); // children continue the outer sequence
      } else {
        node.number = prefix + ++counter.n;
        walk(node.children, node.number + '.', { n: 0 });
      }
    }
  };
  walk(roots, '', { n: 0 });
}

/**
 * Attach the color/icon rank used for theming (0–6).
 *
 * If the document has exactly one `#` heading it is the page title and gets
 * rank 0 (default color, book icon). All other headings are ranked relative
 * to the shallowest remaining level, so in a typical notebook `##` is rank 1
 * (red), `###` rank 2 (orange), and so on. Ranks are capped at 6.
 *
 * @param {object[]} flat all nodes from buildTree
 */
function assignColorRanks(flat) {
  const titles = flat.filter((n) => n.level === 1);
  const title = titles.length === 1 ? titles[0] : undefined;
  const rest = flat.filter((n) => n !== title);
  const min = rest.length ? Math.min(...rest.map((n) => n.level)) : 1;
  for (const n of flat) n.rank = n === title ? 0 : Math.min(n.level - min + 1, 6);
}

/**
 * Apply a case-insensitive substring filter to the tree.
 *
 * Sets `matchAt` on every node (index of the match in its text, or -1) and
 * `visible` (true when the node matches or any descendant matches, so the
 * path to every match stays visible). An empty query makes everything
 * visible.
 *
 * @param {object[]} roots top-level nodes
 * @param {string} query
 */
function applyFilter(roots, query) {
  const q = query.toLowerCase();
  const walk = (node) => {
    node.matchAt = q ? node.text.toLowerCase().indexOf(q) : -1;
    // map() before some() so every descendant is annotated, not just the
    // ones up to the first visible child.
    const childVisible = node.children.map(walk).some(Boolean);
    node.visible = !q || node.matchAt >= 0 || childVisible;
    return node.visible;
  };
  roots.forEach(walk);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * The section containing a position: the last heading at or before `pos`.
 * Binary search, since `flat` is sorted by position.
 *
 * @param {object[]} flat all nodes, in document order
 * @param {number} pos cell index or line index
 * @returns {object | undefined} undefined when `pos` precedes every heading
 */
function headingAt(flat, pos) {
  let lo = 0;
  let hi = flat.length - 1;
  let found;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].pos <= pos) {
      found = flat[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The chain of headings from the top level down to `node` (inclusive).
 *
 * @param {object} node
 * @returns {object[]}
 */
function ancestry(node) {
  const chain = [];
  for (let n = node; n && n.level > 0; n = n.parent) chain.unshift(n);
  return chain;
}

/**
 * Display label: the outline number (if enabled and present) and the text.
 *
 * @param {object} node
 * @param {boolean} numbered whether outline numbers are shown
 * @returns {string} e.g. "1.3.2  CALCULATE LD MATRICES"
 */
function labelOf(node, numbered) {
  return (numbered && node.number ? `${node.number}  ` : '') + node.text;
}

module.exports = {
  cleanText,
  scanHeadings,
  parseNotebookHeadings,
  parseMarkdownHeadings,
  buildTree,
  assignNumbers,
  assignColorRanks,
  applyFilter,
  headingAt,
  ancestry,
  labelOf,
};
