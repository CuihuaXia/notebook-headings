/**
 * tags.js — the pure logic of the cell tag picker.
 *
 * No `vscode` dependency, so it is unit-tested with plain Node. The VS Code
 * side (src/extension.js) reads the tags of one or more cells, shows the
 * picker built by multiPickerEntries(), and writes back the lists computed by
 * nextTagsMulti(); a single cell is simply a list of one.
 */
'use strict';

/**
 * Tags offered in the picker, each with a short English description
 * (translated at runtime through vscode.l10n). They collapse parts of a cell
 * behind a click-to-show toggle in Jupyter Book / MyST pages. Any other tag a
 * cell already has is still listed (as "custom"), and new ones can be typed in.
 */
const COMMON_TAGS = [
  { tag: 'hide-output', description: 'collapse output' },
  { tag: 'hide-input', description: 'collapse code (output stays)' },
  { tag: 'hide-cell', description: 'collapse code and output' },
];

/**
 * Whether a typed tag name is acceptable: non-empty and without whitespace
 * (Jupyter tags cannot contain spaces).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidTag(name) {
  return typeof name === 'string' && name.length > 0 && !/\s/.test(name);
}

/**
 * Picker entries for several cells at once. A tag on every cell starts
 * checked; a tag on only some cells starts unchecked and reports how many
 * cells have it (`count`), so leaving it unchecked can mean "keep as is".
 *
 * @param {string[][]} tagLists the current tags of each selected cell
 * @returns {{ tag: string, description: string, custom: boolean, picked: boolean, count: number }[]}
 */
function multiPickerEntries(tagLists) {
  const total = tagLists.length;
  const countOf = (tag) => tagLists.filter((tags) => tags.includes(tag)).length;
  const seen = [];
  for (const tags of tagLists) for (const t of tags) if (!seen.includes(t)) seen.push(t);
  const entry = (tag, description, custom) => {
    const count = countOf(tag);
    return { tag, description, custom, picked: count === total && total > 0, count };
  };
  const common = COMMON_TAGS.map((c) => entry(c.tag, c.description, false));
  const extra = seen.filter((t) => !COMMON_TAGS.some((c) => c.tag === t)).map((t) => entry(t, '', true));
  return [...common, ...extra];
}

/**
 * New tag lists for several cells after the picker closes:
 * - a checked tag is added to every cell that lacks it;
 * - an unchecked tag that every cell had is removed from every cell;
 * - an unchecked tag that only some cells had is left exactly as it was;
 * - a typed tag (if valid) is added to every cell.
 * Each cell keeps its existing tag order; additions are appended.
 *
 * @param {string[][]} tagLists current tags per cell
 * @param {string[]} checked tags checked in the picker, in picker order
 * @param {string} [typed] text typed into the picker
 * @returns {string[][]}
 */
function nextTagsMulti(tagLists, checked, typed = '') {
  const onAll = (tag) => tagLists.length > 0 && tagLists.every((tags) => tags.includes(tag));
  const custom = typed.trim();
  const add = [...checked];
  if (isValidTag(custom) && !add.includes(custom)) add.push(custom);
  return tagLists.map((tags) => {
    const kept = tags.filter((t) => checked.includes(t) || !onAll(t));
    return [...kept, ...add.filter((t) => !kept.includes(t))];
  });
}

/**
 * Deep copy of a JSON value with object keys sorted alphabetically, as Jupyter
 * writes them; keeps diffs of the .ipynb file free of key-order noise.
 *
 * @param {*} value
 * @returns {*}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, k) => {
        out[k] = sortKeysDeep(value[k]);
        return out;
      }, {});
  }
  return value;
}

module.exports = { COMMON_TAGS, isValidTag, multiPickerEntries, nextTagsMulti, sortKeysDeep };
