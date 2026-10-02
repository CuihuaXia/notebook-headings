// Unit tests for src/headings.js (the pure logic; no VS Code needed).
// Run with: npm test   (uses Node's built-in test runner, Node 18+)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../src/headings');

const examples = path.join(__dirname, '..', 'examples');

/** Build, number and rank a heading list, like the extension does. */
function annotate(headings, total, numberH1 = false) {
  const tree = h.buildTree(headings, 'test|', total);
  h.assignNumbers(tree.roots, numberH1);
  h.assignColorRanks(tree.flat);
  h.applyFilter(tree.roots, '');
  return tree;
}

/** Cells of an .ipynb file in the shape parseNotebookHeadings expects. */
function notebookCells(file) {
  const nb = JSON.parse(fs.readFileSync(file, 'utf8'));
  return nb.cells.map((c) => ({
    isMarkdown: c.cell_type === 'markdown',
    text: [].concat(c.source).join(''),
  }));
}

test('cleanText strips inline markdown', () => {
  assert.equal(h.cleanText('**Bold** and `code` [link](http://x) <b>tag</b>'), 'Bold and code link tag');
});

test('scanHeadings: ATX rules, fences and indentation', () => {
  const found = [];
  const src = [
    '# One',
    '##Not a heading (no space)',
    '   ## Indented three spaces',
    '    ## Indented four spaces (code)',
    '```r',
    '# comment in code',
    '~~~',
    '# still in the ``` fence',
    '```',
    '### Closing hashes ###',
    '####### seven hashes is not a heading',
  ].join('\n');
  h.scanHeadings(src, (level, text, line) => found.push([level, text, line]));
  assert.deepEqual(found, [
    [1, 'One', 0],
    [2, 'Indented three spaces', 2],
    [3, 'Closing hashes', 9],
  ]);
});

test('parseMarkdownHeadings skips YAML front matter', () => {
  const md = '---\ntitle: T\n# not a heading\n---\n# Title\n## Section';
  assert.deepEqual(h.parseMarkdownHeadings(md), [
    { level: 1, text: 'Title', pos: 4 },
    { level: 2, text: 'Section', pos: 5 },
  ]);
});

test('parseMarkdownHeadings: unterminated front matter is content', () => {
  assert.deepEqual(h.parseMarkdownHeadings('---\n# Title'), [{ level: 1, text: 'Title', pos: 1 }]);
});

test('parseNotebookHeadings reads markdown cells only, pos = cell index', () => {
  const cells = [
    { isMarkdown: true, text: '# Title' },
    { isMarkdown: false, text: '# a code comment' },
    { isMarkdown: true, text: '## A\n\n### A.1' },
  ];
  assert.deepEqual(h.parseNotebookHeadings(cells), [
    { level: 1, text: 'Title', pos: 0 },
    { level: 2, text: 'A', pos: 2 },
    { level: 3, text: 'A.1', pos: 2 },
  ]);
});

test('buildTree nests by level and tolerates skipped levels', () => {
  const { roots, flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
      { level: 4, text: 'deep', pos: 2 },
      { level: 2, text: 'B', pos: 3 },
    ],
    5
  );
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].children.map((n) => n.text), ['A', 'B']);
  assert.equal(roots[0].children[0].children[0].text, 'deep');
  assert.deepEqual(flat.map((n) => n.size), [5, 2, 1, 2]);
});

test('buildTree gives unique ids to duplicate sibling titles', () => {
  const { flat } = annotate(
    [
      { level: 2, text: 'Run', pos: 0 },
      { level: 2, text: 'Run', pos: 1 },
    ],
    2
  );
  assert.notEqual(flat[0].id, flat[1].id);
});

test('assignNumbers: a single # title is unnumbered by default', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
      { level: 3, text: 'A1', pos: 2 },
      { level: 2, text: 'B', pos: 3 },
    ],
    4
  );
  assert.deepEqual(flat.map((n) => n.number), ['', '1', '1.1', '2']);
});

test('assignNumbers: numberH1 numbers the title too', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
    ],
    2,
    true
  );
  assert.deepEqual(flat.map((n) => n.number), ['1', '1.1']);
});

test('assignNumbers: sections continue numbering across several # headings', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'X', pos: 0 },
      { level: 2, text: 'a', pos: 1 },
      { level: 1, text: 'Y', pos: 2 },
      { level: 2, text: 'b', pos: 3 },
    ],
    4
  );
  assert.deepEqual(flat.map((n) => n.number), ['', '1', '', '2']);
});

test('assignColorRanks: single title is rank 0, others relative', () => {
  const { flat } = annotate(
    [1, 2, 3, 4, 5, 6].map((level, pos) => ({ level, text: `h${level}`, pos })),
    6
  );
  assert.deepEqual(flat.map((n) => n.rank), [0, 1, 2, 3, 4, 5]);
});

test('assignColorRanks: several # headings are all rank 1', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'X', pos: 0 },
      { level: 1, text: 'Y', pos: 1 },
      { level: 2, text: 'y', pos: 2 },
    ],
    3
  );
  assert.deepEqual(flat.map((n) => n.rank), [1, 1, 2]);
});

test('applyFilter keeps matches and their ancestors visible', () => {
  const { roots, flat } = annotate(
    [
      { level: 1, text: 'Title', pos: 0 },
      { level: 2, text: 'Setup', pos: 1 },
      { level: 3, text: 'Load DATA', pos: 2 },
      { level: 2, text: 'Results', pos: 3 },
    ],
    4
  );
  h.applyFilter(roots, 'data');
  assert.deepEqual(flat.map((n) => n.visible), [true, true, true, false]);
  assert.equal(flat[2].matchAt, 5);
  h.applyFilter(roots, '');
  assert.ok(flat.every((n) => n.visible));
});

test('headingAt finds the enclosing section', () => {
  const { flat } = annotate(
    [
      { level: 2, text: 'A', pos: 2 },
      { level: 2, text: 'B', pos: 5 },
    ],
    9
  );
  assert.equal(h.headingAt(flat, 0), undefined);
  assert.equal(h.headingAt(flat, 2).text, 'A');
  assert.equal(h.headingAt(flat, 4).text, 'A');
  assert.equal(h.headingAt(flat, 8).text, 'B');
});

test('ancestry and labelOf build the copied path', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
      { level: 3, text: 'A1', pos: 2 },
    ],
    3
  );
  const pathText = h.ancestry(flat[2]).map((n) => h.labelOf(n, true)).join(' › ');
  assert.equal(pathText, 'T › 1  A › 1.1  A1');
  assert.equal(h.labelOf(flat[2], false), 'A1');
});

test('examples/sample.ipynb parses as expected', () => {
  const cells = notebookCells(path.join(examples, 'sample.ipynb'));
  const { flat } = annotate(h.parseNotebookHeadings(cells), cells.length);
  assert.deepEqual(
    flat.map((n) => `${n.number || '-'} ${n.text}`),
    [
      '- Sample Notebook',
      '1 Setup',
      '1.1 Load libraries',
      '1.2 Read data',
      '2 Analysis',
      '2.1 Summary',
      '2.1.1 Means',
      '2.1.2 Spread',
      '2.1.2.1 Per-column',
      '2.1.2.1.1 Details',
      '3 Results',
    ]
  );
  assert.equal(flat[1].size, 6); // Setup: cells 1..6
});

test('examples/sample.md parses as expected', () => {
  const text = fs.readFileSync(path.join(examples, 'sample.md'), 'utf8');
  const { flat } = annotate(h.parseMarkdownHeadings(text), text.split('\n').length);
  assert.deepEqual(
    flat.map((n) => `${'#'.repeat(n.level)} ${n.text}`),
    [
      '# Sample Markdown',
      '## Setup',
      '### Install packages',
      '### Configure paths',
      '## Analysis',
      '### Load data',
      '#### Check missing values',
      '##### Per-column summary',
      '###### Raw counts',
      '### Model',
      '## Results',
    ]
  );
});
