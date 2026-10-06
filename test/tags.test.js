// Unit tests for src/tags.js (the cell tag picker logic; no VS Code needed).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/tags');

test('isValidTag rejects empty names and whitespace', () => {
  assert.equal(t.isValidTag('remove-output'), true);
  assert.equal(t.isValidTag('my_tag.2'), true);
  assert.equal(t.isValidTag(''), false);
  assert.equal(t.isValidTag('two words'), false);
  assert.equal(t.isValidTag('tab\there'), false);
});

test('one cell: keeps order, appends new ones, removes unchecked', () => {
  const one = (tags, checked, typed) => t.nextTagsMulti([tags], checked, typed)[0];
  // keep "b", drop "a", add "c" (picker order) and a typed custom tag
  assert.deepEqual(one(['a', 'b'], ['b', 'c'], 'mine'), ['b', 'c', 'mine']);
  // nothing changed
  assert.deepEqual(one(['a', 'b'], ['a', 'b']), ['a', 'b']);
  // everything unchecked
  assert.deepEqual(one(['a'], []), []);
  // typed tag already present or invalid is ignored
  assert.deepEqual(one(['a'], ['a'], 'a'), ['a']);
  assert.deepEqual(one([], [], 'bad tag'), []);
});

test('one cell: common tags first, then the cell\'s other tags, checked', () => {
  const entries = t.multiPickerEntries([['hide-output', 'my-note']]);
  assert.equal(entries[0].tag, 'hide-output');
  assert.equal(entries.find((e) => e.tag === 'hide-output').picked, true);
  assert.equal(entries.find((e) => e.tag === 'hide-cell').picked, false);
  const last = entries[entries.length - 1];
  assert.deepEqual([last.tag, last.custom, last.picked], ['my-note', true, true]);
  assert.equal(entries.length, t.COMMON_TAGS.length + 1);
});

test('every common tag has a description', () => {
  for (const c of t.COMMON_TAGS) assert.ok(c.tag && c.description, c.tag);
});

test('sortKeysDeep sorts object keys recursively and leaves arrays in order', () => {
  const out = t.sortKeysDeep({ b: 1, a: { d: [3, 1], c: { z: 0, y: 0 } } });
  assert.equal(JSON.stringify(out), '{"a":{"c":{"y":0,"z":0},"d":[3,1]},"b":1}');
});

test('multiPickerEntries checks tags on every cell and counts partial ones', () => {
  const e = t.multiPickerEntries([['hide-input', 'note'], ['hide-input'], ['hide-input', 'remove-output']]);
  const get = (tag) => e.find((x) => x.tag === tag);
  assert.deepEqual([get('hide-input').picked, get('hide-input').count], [true, 3]);
  assert.deepEqual([get('remove-output').picked, get('remove-output').count], [false, 1]);
  assert.deepEqual([get('note').custom, get('note').picked, get('note').count], [true, false, 1]);
  assert.equal(get('hide-cell').count, 0);
});

test('nextTagsMulti adds checked, removes unchecked-on-all, keeps partial', () => {
  const before = [['hide-input', 'note'], ['hide-input'], ['hide-input', 'remove-output']];
  // uncheck hide-input (on all) -> removed everywhere; leave partial note/remove-output
  // unchecked -> unchanged; check skip-execution and type "draft" -> added everywhere
  const after = t.nextTagsMulti(before, ['skip-execution'], 'draft');
  assert.deepEqual(after, [['note', 'skip-execution', 'draft'], ['skip-execution', 'draft'], ['remove-output', 'skip-execution', 'draft']]);
  // checking a partial tag adds it to the cells that lacked it
  assert.deepEqual(t.nextTagsMulti([['a'], []], ['a']), [['a'], ['a']]);
  // nothing touched -> nothing changes
  assert.deepEqual(t.nextTagsMulti(before, ['hide-input']), before);
  // invalid typed tag is ignored
  assert.deepEqual(t.nextTagsMulti([[]], [], 'bad tag'), [[]]);
});
