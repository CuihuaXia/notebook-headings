// Unit tests for src/marks.js (heading status and star marks; no VS Code needed).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/marks');
const h = require('../src/headings');

test('readMarks keeps valid entries only', () => {
  const meta = { notebook_headings: { 0: { status: 'todo', star: true }, 1: { status: 'nope' }, x: { star: true }, 2: { star: 'yes' } } };
  assert.deepEqual(m.readMarks(meta), { 0: { status: 'todo', star: true } });
  assert.deepEqual(m.readMarks(undefined), {});
  assert.deepEqual(m.readMarks({ notebook_headings: [1] }), {});
});

test('combineMarks: marks from the file win; 1.5 marks in cell metadata fill in', () => {
  const cells = [
    { isMarkdown: true, text: '## A\n## B' },
    { isMarkdown: false, text: '' },
    { isMarkdown: true, text: '## C' },
  ];
  const headings = h.parseNotebookHeadings(cells).map((x, i) => ({ ...x, cellSlot: x.slot, slot: i }));
  const fileMarks = { 2: { status: 'done', text: 'C' } };
  const cellMarks = [{ 1: { status: 'todo' } }, {}, { 0: { status: 'question' } }];
  const { marks, legacy } = m.combineMarks(headings, fileMarks, (pos) => cellMarks[pos]);
  assert.deepEqual(marks, { 1: { status: 'todo', text: 'B' }, 2: { status: 'done', text: 'C' } });
  assert.deepEqual([...legacy], [1], 'only B still comes from cell metadata');
  assert.deepEqual(m.combineMarks(headings, {}, () => ({})), { marks: {}, legacy: new Set() });
});

test('resolveMarks keeps a mark on its heading when headings are added, removed or renamed', () => {
  const saved = { 1: { status: 'todo', text: 'B' } };
  assert.deepEqual(m.resolveMarks(saved, ['A', 'B']), [undefined, { status: 'todo' }]);
  // A heading inserted above B in the same cell: the mark follows B's text.
  assert.deepEqual(m.resolveMarks(saved, ['New', 'A', 'B']), [undefined, undefined, { status: 'todo' }]);
  // A removed: B is now slot 0.
  assert.deepEqual(m.resolveMarks(saved, ['B']), [{ status: 'todo' }]);
  // B renamed: no text matches, so the mark stays at its slot.
  assert.deepEqual(m.resolveMarks(saved, ['A', 'B v2']), [undefined, { status: 'todo' }]);
  // Duplicate texts: `n` says which occurrence (0 = the first, the default).
  assert.deepEqual(m.resolveMarks({ 1: { star: true, text: 'X' } }, ['X', 'X']), [{ star: true }, undefined]);
  assert.deepEqual(m.resolveMarks({ 1: { star: true, text: 'X', n: 1 } }, ['X', 'X']), [undefined, { star: true }]);
  // Marks saved without text (version 1.5) use their slot.
  assert.deepEqual(m.resolveMarks({ 0: { status: 'done' } }, ['A']), [{ status: 'done' }]);
  // A text match wins over an old slot-only mark at the same slot.
  assert.deepEqual(m.resolveMarks({ 0: { star: true }, 1: { status: 'todo', text: 'A' } }, ['A', 'B']), [
    { status: 'todo' },
    undefined,
  ]);
  // A mark whose heading is gone is dropped.
  assert.deepEqual(m.resolveMarks({ 3: { status: 'todo', text: 'Gone' } }, ['A']), [undefined]);
});

test('marks on headings that share a text follow the right one', () => {
  const pick = (r) => r.map((v, i) => (v ? i : null)).filter((v) => v !== null);
  const texts = ['Intro', 'Summary', 'x', 'Summary', 'Summary'];
  const saved = m.updateMarks({}, texts, 4, { status: 'todo' });
  assert.deepEqual(saved, { 4: { status: 'todo', text: 'Summary', n: 2 } }, 'the third "Summary"');
  assert.deepEqual(pick(m.resolveMarks(saved, ['New', ...texts])), [5], 'a heading inserted above');
  assert.deepEqual(pick(m.resolveMarks(saved, ['Intro', 'x', 'Summary', 'Summary'])), [3], 'an earlier "Summary" removed: nearest');
  assert.deepEqual(m.occurrences(['a', 'b', 'a', 'a']), [0, 0, 1, 2]);
});

test('updateMarks re-keys every mark to its current slot and saves its text', () => {
  const saved = { 0: { status: 'todo' }, 1: { star: true, text: 'B' } };
  const next = m.updateMarks(saved, ['New', 'A', 'B'], 0, { status: 'doing' });
  assert.deepEqual(next, { 0: { status: 'doing', text: 'New' }, 2: { star: true, text: 'B' } });
  // The old slot-only TODO mark on slot 0 moved to 'New' (it has no text to
  // follow), then was overwritten by the patch.
});

test('assignMarks with one container for a whole Markdown file', () => {
  const { flat } = h.buildTree(
    h.parseMarkdownHeadings('# T\n## A\n## B').map((x, i) => ({ ...x, slot: i })),
    '',
    3
  );
  const stored = { 2: { status: 'question', text: 'B' } };
  m.assignMarks(flat, () => stored, [], () => 0);
  assert.deepEqual(flat.map((n) => n.status), [undefined, undefined, 'question']);
});

test('applyMarkedFilter keeps every marked heading (any status or a star) and its parents', () => {
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings([{ isMarkdown: true, text: '## A\n### A1\n### A2\n## B' }]), '', 1);
  const by = (t) => flat.find((n) => n.text === t);
  by('A1').status = 'todo';
  by('A2').status = 'done';
  by('B').star = true;
  assert.equal(m.applyMarkedFilter(roots), 3, 'TODO, Finished and starred');
  assert.deepEqual(flat.filter((n) => n.visible).map((n) => n.text), ['A', 'A1', 'A2', 'B']);
  by('A2').status = undefined;
  by('B').star = false;
  assert.equal(m.applyMarkedFilter(roots), 1);
  assert.deepEqual(flat.filter((n) => n.visible).map((n) => n.text), ['A', 'A1']);
});

test('assignMarks: ??? in the text means To check; an explicit status wins', () => {
  const cells = [
    { isMarkdown: true, text: '## ??? Draft\n### Plain' },
    { isMarkdown: true, text: '## ??? Overridden' },
    { isMarkdown: true, text: '## Starred' },
  ];
  const { flat } = h.buildTree(h.parseNotebookHeadings(cells), '', cells.length);
  const marks = [{ 1: { status: 'todo' } }, { 0: { status: 'done' } }, { 0: { star: true } }];
  m.assignMarks(flat, (pos) => marks[pos], ['???']);
  assert.deepEqual(
    flat.map((n) => [n.text, n.status, n.autoStatus, n.star]),
    [
      ['??? Draft', 'question', true, false],
      ['Plain', 'todo', false, false],
      ['??? Overridden', 'done', false, false],
      ['Starred', undefined, false, true],
    ]
  );
  m.assignMarks(flat, () => ({}), []);
  assert.equal(flat[0].status, undefined, 'no markers configured');
});

test('summarizeMarks counts the statuses below each node, finished included; countsText formats them', () => {
  const cells = [{ isMarkdown: true, text: '# T\n## A\n### A1\n#### A1a\n### A2\n## B' }];
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings(cells), '', 1);
  const status = { A1: 'todo', A1a: 'todo', A2: 'doing', B: 'done' };
  flat.forEach((n) => ((n.status = status[n.text]), (n.star = n.text === 'A1' || n.text === 'B')));
  m.summarizeMarks(roots);
  const by = (t) => flat.find((n) => n.text === t);
  assert.deepEqual(by('T').counts, { todo: 2, doing: 1, done: 1, star: 2 });
  assert.deepEqual(by('A1').counts, { todo: 1 });
  assert.deepEqual(by('B').counts, {});
  assert.equal(m.countsText(by('T').counts), '○2 ➤1 ✓1 ★2');
  assert.equal(m.countsText(by('A').counts), '○2 ➤1 ★1');
  assert.equal(m.countsText({}), '');
});

test('applyMarkedFilter keeps marked headings and their ancestors', () => {
  const cells = [{ isMarkdown: true, text: '# T\n## A\n### A1\n## B\n### B1' }];
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings(cells), '', 1);
  flat.forEach((n) => ((n.star = n.text === 'A1'), (n.status = n.text === 'B1' ? 'done' : undefined)));
  assert.equal(m.applyMarkedFilter(roots), 2);
  assert.deepEqual(flat.filter((n) => n.visible).map((n) => n.text), ['T', 'A', 'A1', 'B', 'B1']);
});

test('every status has a unique id, a codicon, a summary symbol and an icon file in its color', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  assert.equal(new Set(m.STATUSES.map((s) => s.id)).size, m.STATUSES.length);
  for (const s of m.STATUSES) {
    assert.ok(s.icon, s.id);
    assert.ok(s.symbol, s.id);
    const svg = fs.readFileSync(path.join(__dirname, '..', 'media', 'status', `${s.id}.svg`), 'utf8');
    assert.ok(svg.includes(`fill="${s.fill}"`), `${s.id}.svg uses ${s.fill}`);
  }
});

test('summarizeMarks reaches all six levels', () => {
  const cells = [{ isMarkdown: true, text: '# T\n## L2\n### L3\n#### L4\n##### L5\n###### L6' }];
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings(cells), '', 1);
  flat.find((n) => n.text === 'L6').status = 'question';
  flat.find((n) => n.text === 'L5').status = 'todo';
  m.summarizeMarks(roots);
  for (const t of ['T', 'L2', 'L3', 'L4']) assert.deepEqual(flat.find((n) => n.text === t).counts, { todo: 1, question: 1 }, t);
  assert.deepEqual(flat.find((n) => n.text === 'L5').counts, { question: 1 });
});

test('summarizeMarks collects every status below; iconFile picks grid, status, star or none', () => {
  const cells = [{ isMarkdown: true, text: '# T\n## A\n### A1\n#### A1a\n### A2\n## B' }];
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings(cells), '', 1);
  const status = { A: 'question', A1a: 'done', A2: 'doing' };
  flat.forEach((n) => (n.status = status[n.text]));
  m.summarizeMarks(roots);
  const by = (t) => flat.find((n) => n.text === t);
  assert.deepEqual([...by('A').below].sort(), ['doing', 'done']);
  assert.deepEqual([...by('T').below].sort(), ['doing', 'done', 'question']);
  assert.equal(by('B').below.size, 0);
  assert.equal(m.iconFile({ group: ['doing', 'done'] }), 'group-0101.svg');
  assert.equal(m.iconFile({ group: ['todo', 'doing', 'question', 'done'], star: true, status: 'todo' }), 'group-1111-star.svg');
  assert.equal(m.iconFile({ group: [], status: 'question' }), 'question.svg');
  assert.equal(m.iconFile({ status: 'done', star: true }), 'done-star.svg');
  assert.equal(m.iconFile({ star: true }), 'star.svg');
  assert.equal(m.iconFile({}), undefined);
});

test('the icon files on disk match STATUSES (run npm run icons after changes)', () => {
  for (const s of m.STATUSES) {
    for (const star of [false, true]) {
      const name = m.iconFile({ status: s.id, star });
      const svg = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'status', name), 'utf8');
      assert.ok(svg.includes(s.fill) && svg.includes(m.STAR_FILL) === star, name);
    }
  }
  assert.ok(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'status', 'star.svg'), 'utf8').includes(m.STAR_FILL));
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'media', 'status');
  for (let mask = 1; mask < 1 << m.STATUSES.length; mask++) {
    const ids = m.STATUSES.filter((_, i) => (mask >> i) & 1).map((s) => s.id);
    for (const star of [false, true]) {
      const name = m.iconFile({ group: ids, star });
      const svg = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const s of m.STATUSES) assert.equal(svg.includes(s.fill), ids.includes(s.id), `${name} ${s.id}`);
      assert.equal(svg.includes(m.STAR_FILL), star, `${name} star`);
    }
  }
});
