/**
 * tags.js — the pure logic of the cell tag picker.
 *
 * No `vscode` dependency, so it is unit-tested with plain Node. The VS Code
 * side (src/extension.js) reads a cell's tags, shows the picker built from
 * COMMON_TAGS, and writes back the list computed by nextTags().
 */
'use strict';

/**
 * Tags offered in the picker, in display order, with an English description
 * (translated at runtime through vscode.l10n). Most are understood by
 * Jupyter Book / MyST and nbconvert; `parameters` is Papermill's.
 */
const COMMON_TAGS = [
  { tag: 'hide-input', description: 'Jupyter Book / MyST: code collapsed behind a toggle' },
  { tag: 'hide-output', description: 'Jupyter Book / MyST: output collapsed behind a toggle' },
  { tag: 'hide-cell', description: 'Jupyter Book / MyST: whole cell collapsed behind a toggle' },
  { tag: 'remove-input', description: 'Jupyter Book / MyST: code removed from the page' },
  { tag: 'remove-output', description: 'Jupyter Book / MyST: output removed from the page' },
  { tag: 'remove-cell', description: 'Jupyter Book / MyST: whole cell removed from the page' },
  { tag: 'skip-execution', description: 'Skipped when the book executes the notebook' },
  { tag: 'raises-exception', description: 'Expected to raise an error; execution continues' },
  { tag: 'parameters', description: 'Papermill: the parameters cell' },
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
 * The cell's new tag list after the picker closes.
 *
 * - Tags that stay checked keep their original order.
 * - Newly checked tags are appended in the picker's order.
 * - A typed tag (if valid and not already present) is appended last.
 *
 * Every current tag is offered in the picker, so unchecking it removes it.
 *
 * @param {string[]} current tags on the cell now
 * @param {string[]} checked tags checked in the picker, in picker order
 * @param {string} [typed] text typed into the picker (a custom tag)
 * @returns {string[]}
 */
function nextTags(current, checked, typed = '') {
  const keep = current.filter((t) => checked.includes(t));
  const added = checked.filter((t) => !current.includes(t));
  const result = [...keep, ...added];
  const custom = typed.trim();
  if (isValidTag(custom) && !result.includes(custom)) result.push(custom);
  return result;
}

/**
 * Picker entries: the common tags first, then any other tags the cell already
 * has (so they can be unchecked), each marked as checked or not.
 *
 * @param {string[]} current tags on the cell now
 * @returns {{ tag: string, description: string, custom: boolean, picked: boolean }[]}
 */
function pickerEntries(current) {
  const common = COMMON_TAGS.map((c) => ({ ...c, custom: false, picked: current.includes(c.tag) }));
  const extra = current
    .filter((t) => !COMMON_TAGS.some((c) => c.tag === t))
    .map((t) => ({ tag: t, description: '', custom: true, picked: true }));
  return [...common, ...extra];
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

module.exports = { COMMON_TAGS, isValidTag, nextTags, pickerEntries, sortKeysDeep };
