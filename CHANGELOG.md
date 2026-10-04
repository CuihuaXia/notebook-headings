# Changelog

## 1.3.0 — 2026-10-04

- **Cell tags in one click**: a **Tags** button at the bottom right of every
  notebook cell opens a checklist of common tags (`hide-input`,
  `remove-output`, `skip-execution`, `parameters`, …) with explanations, and
  accepts custom tags. Also available as **Notebook Headings: Edit Cell
  Tags…** in the command palette. New setting `notebookHeadings.cellTagButton`
  (on by default).
- This is the only edit the extension can make to a document: it changes just
  the cell's tags and can be undone with `Cmd+Z`.

## 1.2.0 — 2026-10-04

- **Output sizes**: each notebook heading now shows its section's total output
  size next to the cell count, e.g. `34 · 2.1 MB` (also in the tooltip and in
  Go to Heading). New setting `notebookHeadings.showOutputSize` (on by
  default).
- **Chinese interface**: commands, menus, settings and messages follow VS
  Code's display language (English or Chinese).

## 1.1.0 — 2026-10-04

- **Select Section** (right-click a heading): selects every cell, or line in
  Markdown, of the section including its subsections, so it can be cut,
  copied, moved, run or deleted with VS Code's own commands. Documents are
  still never modified by the extension itself.

## 1.0.2 — 2026-10-02

- Documentation: the README now covers installing and using the extension;
  building from source, debugging and the project layout moved to
  `CONTRIBUTING.md`. No changes to the extension's behavior.

## 1.0.1 — 2026-10-02

First public release. (1.0.0 was a short-lived Marketplace build with the
same features.)

- Heading outline for Jupyter notebooks and Markdown files that opens expanded
  only to a chosen level (default `##`), keeping all six heading levels.
- Outline numbers, per-level colors and shape icons, and cell counts per
  notebook section.
- Follows the cursor and scroll position; the current section is shown in the
  status bar.
- Live filter and a **Go to Heading…** quick pick (`Cmd+Alt+O`).
- Right-click to copy a heading's text or its full path.
- Markdown parsing skips YAML front matter and fenced code blocks.
- Read-only: documents are never modified.
