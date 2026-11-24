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

test('resolveMarks keeps a mark on its heading when other headings are added or removed', () => {
  const saved = { 1: { status: 'todo', text: 'B' } };
  assert.deepEqual(m.resolveMarks(saved, ['A', 'B']), [undefined, { status: 'todo' }]);
  // A heading inserted above B in the same cell: the mark follows B's text.
  assert.deepEqual(m.resolveMarks(saved, ['New', 'A', 'B']), [undefined, undefined, { status: 'todo' }]);
  // A removed: B is now slot 0.
  assert.deepEqual(m.resolveMarks(saved, ['B']), [{ status: 'todo' }]);
  // B deleted, or renamed outside VS Code: the mark goes nowhere, and never
  // to the heading that took its slot (it used to, before 1.14.0).
  assert.deepEqual(m.resolveMarks(saved, ['A', 'B v2']), [undefined, undefined]);
  assert.deepEqual(m.resolveMarks(saved, ['A', 'C', 'D']), [undefined, undefined, undefined]);
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

test('alignTexts pairs headings before and after an edit', () => {
  assert.deepEqual(m.alignTexts(['A', 'B', 'C'], ['A', 'B', 'C']), [0, 1, 2], 'unchanged');
  assert.deepEqual(m.alignTexts(['A', 'B', 'C'], ['A', 'B2', 'C']), [0, 1, 2], 'B renamed');
  assert.deepEqual(m.alignTexts(['A', 'B', 'C'], ['A', 'C']), [0, -1, 1], 'B deleted');
  assert.deepEqual(m.alignTexts(['A', 'B'], ['A', 'New', 'B']), [0, 2], 'a heading added');
  assert.deepEqual(m.alignTexts(['A'], ['A2']), [0], 'the only heading renamed');
  assert.deepEqual(m.alignTexts(['A', 'B'], ['X']), [-1, -1], 'two headings became one: neither is kept');
  assert.deepEqual(m.alignTexts([], ['A']), []);
});

test('followMarks follows renames, drops deleted headings, keeps marks off copies', () => {
  const texts = ['Analysis', 'Load data', 'Model'];
  const stored = { 1: { status: 'todo', text: 'Load data' } };
  const shown = (marks, after) => m.resolveMarks(marks, after).map((x, i) => (x ? `${after[i]}:${x.status || ''}${x.star ? '*' : ''}` : null)).filter(Boolean);
  // Renamed in place: the stored text changes with it.
  let after = ['Analysis', 'Load raw data', 'Model'];
  let next = m.followMarks(stored, texts, after, [0, 1, 2]);
  assert.deepEqual(next, { 1: { status: 'todo', text: 'Load raw data' } });
  // Deleted: nothing shows it, and nothing needs writing (no neighbor takes it).
  after = ['Analysis', 'Model'];
  assert.equal(m.followMarks(stored, texts, after, [0, -1, 1]), undefined);
  assert.deepEqual(shown(stored, after), []);
  // ...and pasted back (cut and paste): the new heading with that text gets it.
  assert.equal(m.followMarks(stored, after, texts, [0, 2]), undefined, 'text match already shows it');
  // Copy pasted below: the original keeps it, nothing to write.
  after = ['Analysis', 'Load data', 'Load data', 'Model'];
  assert.equal(m.followMarks(stored, texts, after, [0, 1, 3]), undefined);
  assert.deepEqual(m.resolveMarks(stored, after).map(Boolean), [false, true, false, false]);
  // Copy pasted above: the original (now the second "Load data") keeps it.
  next = m.followMarks(stored, texts, after, [0, 2, 3]);
  assert.deepEqual(next, { 2: { status: 'todo', text: 'Load data', n: 1 } });
  assert.deepEqual(m.resolveMarks(next, after).map(Boolean), [false, false, true, false]);
  // A deleted heading's mark never lands on another heading with its text.
  const two = { 3: { status: 'todo', text: 'Summary', n: 1 } };
  next = m.followMarks(two, ['A', 'Summary', 'B', 'Summary'], ['A', 'Summary', 'B'], [0, 1, 2, -1]);
  assert.deepEqual(next, {});
  // A deleted heading's mark is kept while it matches nothing.
  next = m.followMarks({ ...stored, 2: { star: true, text: 'Model' } }, texts, ['Analysis', 'Load data 2'], [0, 1, -1]);
  assert.deepEqual(next, { 1: { status: 'todo', text: 'Load data 2' }, 2: { star: true, text: 'Model' } });
  assert.deepEqual(shown(next, ['Analysis', 'Load data 2', 'Model']), ['Load data 2:todo', 'Model:*'], 'pasted back');
  // Marks of unchanged headings need no write when other headings move.
  assert.equal(m.followMarks(stored, texts, ['New', ...texts], [1, 2, 3]), undefined);
});

test('notebook marks with a cell id follow the cell, whatever its text', () => {
  const places = (...ids) => ids.map((id) => (id ? { cell: id, k: 0 } : undefined));
  const stored = { 1: { status: 'todo', text: 'Load data', cell: 'c2' } };
  // Renamed anywhere (another editor, a git pull): the id still finds it.
  assert.deepEqual(m.resolveMarks(stored, ['Analysis', 'Load raw data', 'Model'], places('c1', 'c2', 'c3')), [undefined, { status: 'todo' }, undefined]);
  // Moved, with other cells added: still that cell.
  assert.deepEqual(m.resolveMarks(stored, ['New', 'Model', 'Read', 'Analysis'], places('c9', 'c3', 'c2', 'c1')).map(Boolean), [false, false, true, false]);
  // The id beats the text: another cell with the old text does not take it.
  assert.deepEqual(m.resolveMarks(stored, ['Load data', 'Renamed'], places('c7', 'c2')).map(Boolean), [false, true]);
  // The cell is gone (deleted, or cut and pasted, which gives a new id): the text decides.
  assert.deepEqual(m.resolveMarks(stored, ['Analysis', 'Load data'], places('c1', 'c8')).map(Boolean), [false, true]);
  // Several headings in the cell: its index in the cell, then the text.
  const two = { 0: { status: 'done', text: 'B', cell: 'x', k: 1 } };
  const inX = [{ cell: 'x', k: 0 }, { cell: 'x', k: 1 }];
  assert.deepEqual(m.resolveMarks(two, ['A', 'B2'], inX).map(Boolean), [false, true], 'renamed: same index');
  assert.deepEqual(m.resolveMarks(two, ['B', 'New'], inX).map(Boolean), [true, false], 'moved up in the cell: same text');
  // A pasted copy that still has the original's id: the stored occurrence decides.
  const dup = { 1: { status: 'todo', text: 'R', n: 1, cell: 'c2' } };
  assert.deepEqual(m.resolveMarks(dup, ['A', 'R', 'R'], places('c1', 'c2', 'c2')).map(Boolean), [false, false, true]);
  // Setting a mark stores the id and the index in the cell (when not 0).
  assert.deepEqual(m.updateMarks({}, ['A', 'B'], 1, { status: 'todo' }, inX), { 1: { status: 'todo', text: 'B', cell: 'x', k: 1 } });
  assert.deepEqual(m.placesOf([{ cellId: 'x', cellSlot: 1 }, {}]), [{ cell: 'x', k: 1 }, undefined]);
  // Old marks get the id at the next edit; a rename with an id needs only the new text.
  const old = { 1: { status: 'todo', text: 'Load data' } };
  const p = places('c1', 'c2');
  assert.deepEqual(m.followMarks(old, ['A', 'Load data'], ['A', 'Load data'], [0, 1], p, p), { 1: { status: 'todo', text: 'Load data', cell: 'c2' } });
  const withId = { 1: { status: 'todo', text: 'Load data', cell: 'c2' } };
  assert.equal(m.followMarks(withId, ['A', 'Load data'], ['New', 'A', 'Load data'], [1, 2], p, places('c0', 'c1', 'c2')), undefined, 'no write for a heading added above');
  assert.deepEqual(m.followMarks(withId, ['A', 'Load data'], ['A', 'Read'], [0, 1], p, p), { 1: { status: 'todo', text: 'Read', cell: 'c2' } });
  // Reloaded from disk with the heading renamed (every cell is new): the id keeps it.
  assert.deepEqual(m.followMarks(withId, ['A', 'Load data'], ['A', 'Read'], [-1, -1], p, p), { 1: { status: 'todo', text: 'Read', cell: 'c2' } });
  assert.deepEqual(m.cleanMarks({ 0: { status: 'todo', cell: 'abc', k: 2 }, 1: { status: 'todo', cell: 5, k: -1 } }), {
    0: { status: 'todo', cell: 'abc', k: 2 },
    1: { status: 'todo' },
  });
});

test('a status is dated when set, keeps its date when set again, and loses it when cleared', () => {
  const texts = ['A', 'B'];
  let marks = m.updateMarks({}, texts, 1, { status: 'todo' }, [], '2026-11-24');
  assert.deepEqual(marks, { 1: { status: 'todo', since: '2026-11-24', text: 'B' } });
  assert.equal(m.updateMarks(marks, texts, 1, { status: 'todo' }, [], '2026-12-01')[1].since, '2026-11-24', 'same status: same date');
  assert.equal(m.updateMarks(marks, texts, 1, { star: true }, [], '2026-12-01')[1].since, '2026-11-24', 'pinning keeps it');
  marks = m.updateMarks(marks, texts, 1, { status: 'done' }, [], '2026-12-01');
  assert.equal(marks[1].since, '2026-12-01', 'a new status: a new date');
  assert.deepEqual(m.updateMarks(marks, texts, 1, { status: null, star: true }, [], '2026-12-02'), { 1: { star: true, text: 'B' } });
  assert.deepEqual(m.resolveMarks(marks, texts), [undefined, { status: 'done', since: '2026-12-01' }]);
  assert.deepEqual(m.cleanMarks({ 0: { status: 'todo', since: 'yesterday' }, 1: { star: true, since: '2026-11-24' } }), {
    0: { status: 'todo' },
    1: { star: true },
  });
  const { flat } = h.buildTree(h.parseMarkdownHeadings('# A\n## B').map((x, i) => ({ ...x, slot: i })), '', 2);
  m.assignMarks(flat, () => marks, [], () => 0);
  assert.equal(flat[1].since, '2026-12-01');
});

test('marks matching no heading are listed and kept until removed', () => {
  const stored = { 0: { status: 'todo', text: 'A' }, 3: { status: 'done', text: 'Gone' }, 4: { status: 'todo' } };
  assert.deepEqual(m.lostMarks(stored, ['A', 'B']), [{ key: '3', mark: { status: 'done', text: 'Gone' } }], 'marks without text (1.5) are not "lost"');
  // Setting another mark keeps the lost one, under a key past the headings.
  const next = m.updateMarks(stored, ['A', 'B'], 1, { status: 'doing' });
  assert.deepEqual(Object.values(next).map((x) => x.text), ['A', 'B', 'Gone']);
  assert.deepEqual(m.lostMarks(next, ['A', 'B']).map((l) => l.mark.text), ['Gone']);
  // ...but never where it would take a heading's place.
  const two = m.updateMarks({ 1: { status: 'todo', text: 'S', n: 1 } }, ['S', 'S'], 1, { status: null });
  assert.deepEqual(m.resolveMarks(two, ['S', 'S']), [undefined, undefined]);
});

test('followLine says where a line went after an edit', () => {
  const at = (sl, sc, el, ec, text) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec }, text });
  assert.equal(m.followLine(5, [at(5, 3, 5, 6, 'xyz')]), 5, 'typing in the heading line');
  assert.equal(m.followLine(5, [at(5, 0, 5, 0, '#')]), 5, 'a # added at its start');
  assert.equal(m.followLine(5, [at(5, 0, 5, 0, '\n')]), 6, 'Enter at its start');
  assert.equal(m.followLine(5, [at(5, 0, 5, 0, '## New\ntext\n')]), 7, 'lines pasted at its start');
  assert.equal(m.followLine(5, [at(1, 0, 1, 0, 'a\nb\n')]), 7, 'two lines added above');
  assert.equal(m.followLine(5, [at(2, 0, 3, 0, '')]), 4, 'a line above deleted');
  assert.equal(m.followLine(5, [at(5, 0, 6, 0, '')]), -1, 'the line itself deleted');
  assert.equal(m.followLine(5, [at(3, 0, 7, 0, '')]), -1, 'inside a deleted block');
  assert.equal(m.followLine(5, [at(5, 9, 5, 9, '\nmore')]), 5, 'Enter at its end');
  assert.equal(m.followLine(5, [at(4, 9, 5, 0, '')]), 4, 'joined to the line above (Backspace at its start)');
  assert.equal(m.followLine(5, [at(8, 0, 8, 0, 'x\n')]), 5, 'an edit below');
  assert.equal(m.followLine(5, [at(9, 0, 9, 0, 'x\n'), at(1, 0, 1, 0, 'y\n')]), 6, 'several changes');
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
  assert.equal(m.applyMarkedFilter(roots), 3, 'TODO, Finished and pinned');
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
    { isMarkdown: true, text: '## Pinned' },
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
      ['Pinned', undefined, false, true],
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
  assert.equal(m.countsText(by('T').counts), '○2 ➤1 ✓1 ⤒2');
  assert.equal(m.countsText(by('A').counts), '○2 ➤1 ⤒1');
  assert.equal(m.countsText({}), '');
});

test('applyMarkedFilter keeps the whole section of a marked heading, all levels down', () => {
  const cells = [{ isMarkdown: true, text: '# T\n## A\n### A1\n#### A1a\n##### A1a1\n### A2\n## B\n### B1' }];
  const { roots, flat } = h.buildTree(h.parseNotebookHeadings(cells), '', 1);
  const visible = () => flat.filter((n) => n.visible).map((n) => n.text);
  flat.forEach((n) => (n.star = n.text === 'A1'));
  assert.equal(m.applyMarkedFilter(roots), 1, 'only marked headings are counted');
  assert.deepEqual(visible(), ['T', 'A', 'A1', 'A1a', 'A1a1'], 'A1 with its section and parents; not A2 or B');
  flat.forEach((n) => ((n.star = false), (n.status = n.text === 'A' ? 'todo' : undefined)));
  assert.equal(m.applyMarkedFilter(roots), 1);
  assert.deepEqual(visible(), ['T', 'A', 'A1', 'A1a', 'A1a1', 'A2']);
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
  assert.equal(m.iconFile({ group: ['todo', 'doing', 'question', 'done'], star: true, status: 'todo' }), 'group-1111-pin.svg');
  assert.equal(m.iconFile({ group: [], status: 'question' }), 'question.svg');
  assert.equal(m.iconFile({ status: 'done', star: true }), 'done-pin.svg');
  assert.equal(m.iconFile({ star: true }), 'pin.svg');
  assert.equal(m.iconFile({}), undefined);
});

test('the icon files on disk match STATUSES (run npm run icons after changes)', () => {
  for (const s of m.STATUSES) {
    for (const star of [false, true]) {
      const name = m.iconFile({ status: s.id, star });
      const svg = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'status', name), 'utf8');
      assert.ok(svg.includes(s.fill) && svg.includes(m.PIN_FILL) === star, name);
    }
  }
  assert.ok(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'status', 'pin.svg'), 'utf8').includes(m.PIN_FILL));
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'media', 'status');
  for (let mask = 1; mask < 1 << m.STATUSES.length; mask++) {
    const ids = m.STATUSES.filter((_, i) => (mask >> i) & 1).map((s) => s.id);
    for (const star of [false, true]) {
      const name = m.iconFile({ group: ids, star });
      const svg = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const s of m.STATUSES) assert.equal(svg.includes(s.fill), ids.includes(s.id), `${name} ${s.id}`);
      assert.equal(svg.includes(m.PIN_FILL), star, `${name} pin`);
    }
  }
});
