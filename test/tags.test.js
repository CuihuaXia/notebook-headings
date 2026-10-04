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

test('nextTags keeps order, appends new ones, removes unchecked', () => {
  // keep "b", drop "a", add "c" (picker order) and a typed custom tag
  assert.deepEqual(t.nextTags(['a', 'b'], ['b', 'c'], 'mine'), ['b', 'c', 'mine']);
  // nothing changed
  assert.deepEqual(t.nextTags(['a', 'b'], ['a', 'b']), ['a', 'b']);
  // everything unchecked
  assert.deepEqual(t.nextTags(['a'], []), []);
  // typed tag already present or invalid is ignored
  assert.deepEqual(t.nextTags(['a'], ['a'], 'a'), ['a']);
  assert.deepEqual(t.nextTags([], [], 'bad tag'), []);
});

test('pickerEntries lists common tags first, then the cell\'s other tags, checked', () => {
  const entries = t.pickerEntries(['hide-output', 'my-note']);
  assert.equal(entries[0].tag, 'hide-input');
  assert.equal(entries.find((e) => e.tag === 'hide-output').picked, true);
  assert.equal(entries.find((e) => e.tag === 'remove-cell').picked, false);
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
