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

test('withMark sets, clears and removes empty entries without touching other metadata', () => {
  const base = { tags: ['hide-input'] };
  const a = m.withMark(base, 0, { status: 'doing' });
  assert.deepEqual(a, { tags: ['hide-input'], notebook_headings: { 0: { status: 'doing' } } });
  assert.deepEqual(base, { tags: ['hide-input'] }, 'input is not modified');
  const b = m.withMark(a, 1, { star: true });
  assert.deepEqual(b.notebook_headings, { 0: { status: 'doing' }, 1: { star: true } });
  const c = m.withMark(m.withMark(b, 0, { status: null }), 1, { star: false });
  assert.deepEqual(c, { tags: ['hide-input'] });
});

test('assignMarks: explicit status wins over ??? in the text', () => {
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
      ['??? Draft', 'doing', true, false],
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
  assert.equal(m.applyMarkedFilter(roots), 1);
  assert.deepEqual(flat.filter((n) => n.visible).map((n) => n.text), ['T', 'A', 'A1']);
});

test('every status has a unique id, a codicon, an icon file in its color; open ones a summary symbol', () => {
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
