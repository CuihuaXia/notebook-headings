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
  assert.equal(h.cleanText('*Draft* _v2_ ~~old~~ R &amp; D &#39;x&#39; &#x41;'), "Draft v2 old R & D 'x' A");
  assert.equal(h.cleanText('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
  assert.equal(h.cleanText('Title <!-- note -->'), 'Title');
  assert.equal(h.cleanText('&unknown; stays'), '&unknown; stays');
});

test('scanHeadings: HTML comment blocks are skipped', () => {
  const found = [];
  const src = ['<!--', '## Hidden draft', '-->', '## Real', '<!-- one line --> ', '## After', '  <!-- open', '# Also hidden', 'still --> text', '## Last'];
  h.scanHeadings(src.join('\n'), (level, text, line) => found.push([level, text, line]));
  assert.deepEqual(found, [
    [2, 'Real', 3],
    [2, 'After', 5],
    [2, 'Last', 9],
  ]);
});

test('scanHeadings: setext headings', () => {
  const found = [];
  const src = [
    'Title', // 0
    '=====', // 1 -> level 1 at line 0
    '',
    'A long', // 3
    'subtitle', // 4
    '---', // 5 -> level 2 "A long subtitle" at line 3
    '',
    '---', // 7: thematic break, no paragraph above
    '- list item', // 8
    '---', // 9: not a heading under a list item
    '```',
    'code',
    '---', // inside a fence
    '```',
    '## ATX', // 14
  ];
  h.scanHeadings(src.join('\n'), (level, text, line) => found.push([level, text, line]));
  assert.deepEqual(found, [
    [1, 'Title', 0],
    [2, 'A long subtitle', 3],
    [2, 'ATX', 14],
  ]);
});

test('parseNotebookHeadings skips front matter in the first cell only', () => {
  const cells = [
    { isMarkdown: true, text: '---\ntitle: x\n---\n# Title' },
    { isMarkdown: true, text: 'Para\n---' },
  ];
  assert.deepEqual(
    h.parseNotebookHeadings(cells).map((x) => [x.level, x.text, x.pos]),
    [
      [1, 'Title', 0],
      [2, 'Para', 1],
    ]
  );
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

test('scanHeadings: a closing # needs a space before it', () => {
  const got = [];
  h.scanHeadings('## Learn C#\n## Issue #12\n### Done ###\n## A # B', (l, t) => got.push(t));
  assert.deepEqual(got, ['Learn C#', 'Issue #12', 'Done', 'A # B']);
});

test('scanHeadings: a fence closes only with an equal or longer fence', () => {
  const md = [
    '````md', // opens a 4-backtick fence
    '# inside',
    '```', // too short: still inside
    '# still inside',
    '```` trailing text', // has text after it: still inside
    '````', // closes
    '# after',
    '~~~',
    '```',
    '# inside tildes', // a backtick line does not close a tilde fence
    '~~~~',
    '## end',
  ].join('\n');
  const got = [];
  h.scanHeadings(md, (l, t) => got.push(t));
  assert.deepEqual(got, ['after', 'end']);
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

test('parseNotebookHeadings reads markdown cells only, pos = cell index, slot = index in cell', () => {
  const cells = [
    { isMarkdown: true, text: '# Title' },
    { isMarkdown: false, text: '# a code comment' },
    { isMarkdown: true, text: '## A\n\n### A.1' },
  ];
  assert.deepEqual(h.parseNotebookHeadings(cells), [
    { level: 1, text: 'Title', pos: 0, slot: 0 },
    { level: 2, text: 'A', pos: 2, slot: 0 },
    { level: 3, text: 'A.1', pos: 2, slot: 1 },
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

test('sectionRange covers the heading and its subsections', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
      { level: 3, text: 'A1', pos: 3 },
      { level: 2, text: 'B', pos: 6 },
    ],
    9
  );
  assert.deepEqual(h.sectionRange(flat, flat[1]), { start: 1, end: 6, sharedWith: [] }); // A + A1
  assert.deepEqual(h.sectionRange(flat, flat[2]), { start: 3, end: 6, sharedWith: [] });
  assert.deepEqual(h.sectionRange(flat, flat[3]), { start: 6, end: 9, sharedWith: [] }); // to the end
  assert.equal(h.sectionRange(flat, flat[0]).end, 9); // the title spans everything
});

test('sectionRange reports headings that share the first cell', () => {
  const cells = [
    { isMarkdown: true, text: '## Summary\n\n### Means' },
    { isMarkdown: false, text: 'df.mean()' },
    { isMarkdown: true, text: '### Spread' },
  ];
  const { flat } = annotate(h.parseNotebookHeadings(cells), cells.length);
  const means = flat.find((n) => n.text === 'Means');
  const r = h.sectionRange(flat, means);
  assert.deepEqual([r.start, r.end], [0, 2]);
  assert.deepEqual(r.sharedWith.map((n) => n.text), ['Summary']);
  assert.deepEqual(h.sectionRange(flat, flat[0]).sharedWith, []);
});

test('assignOutputSizes sums the outputs of each section', () => {
  const { flat } = annotate(
    [
      { level: 1, text: 'T', pos: 0 },
      { level: 2, text: 'A', pos: 1 },
      { level: 3, text: 'A1', pos: 3 },
      { level: 2, text: 'B', pos: 5 },
    ],
    7
  );
  //            cell: 0  1   2    3  4     5  6
  h.assignOutputSizes(flat, [0, 0, 100, 0, 2000, 0, 5]);
  assert.deepEqual(flat.map((n) => n.bytes), [2105, 2100, 2000, 5]);
});

test('formatBytes uses decimal units and hides zero', () => {
  assert.equal(h.formatBytes(0), '');
  assert.equal(h.formatBytes(undefined), '');
  assert.equal(h.formatBytes(512), '512 B');
  assert.equal(h.formatBytes(1_000), '1 KB');
  assert.equal(h.formatBytes(2_500), '2.5 KB');
  assert.equal(h.formatBytes(9_960), '10 KB');
  assert.equal(h.formatBytes(48_400), '48 KB');
  assert.equal(h.formatBytes(2_140_000), '2.1 MB');
  assert.equal(h.formatBytes(1_300_000_000), '1.3 GB');
  assert.equal(h.formatBytes(999_600), '1 MB', 'rounds up into the next unit');
  assert.equal(h.formatBytes(2_000_000), '2 MB', 'same rule in every unit');
  assert.equal(h.formatBytes(120_000_000), '120 MB');
});

test('mergeRanges merges nested, overlapping and touching ranges', () => {
  assert.deepEqual(h.mergeRanges([]), []);
  // a section and its own subsection, given out of order
  assert.deepEqual(h.mergeRanges([{ start: 3, end: 5 }, { start: 1, end: 6 }]), [{ start: 1, end: 6 }]);
  // touching sections become one range; a separate one stays separate
  assert.deepEqual(
    h.mergeRanges([{ start: 6, end: 9 }, { start: 1, end: 6 }, { start: 12, end: 14 }]),
    [{ start: 1, end: 9 }, { start: 12, end: 14 }]
  );
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
