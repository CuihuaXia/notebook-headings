# Changelog

## 1.6.0 — 2026-10-08

**New**

- **Clear Section Outputs…** (right-click a notebook heading): clears the
  outputs of a section after a confirmation; code is kept, `Cmd+Z` undoes it.
- **Show Marked Headings** can show all marks, only stars, or one status.
- Status marks and stars now work in **Markdown files** too.

**Changed**

- **Marks are kept in the project, not in your documents**, in
  `.vscode/notebook-headings.json`. Setting a mark no longer changes the
  notebook, and marks travel with the project to other computers. If git
  ignores that file, the extension says so and offers **Fix .gitignore**.
  Marks can no longer be undone with `Cmd+Z`, and renaming a document outside
  VS Code (Finder, `git mv`) loses them.
- Documents that git ignores keep their marks on this computer only, so their
  paths and headings never reach the repository.
- Marks follow their heading's text, so editing other headings no longer
  moves them. Marks saved by 1.5.0 still work and move to the file when changed.
- Setext (`===` / `---`) headings are recognized; headings in HTML comments
  and front matter in a notebook's first cell are ignored. Labels drop
  italic and strikethrough markers and decode entities like `&amp;`.
- Output sizes use one rule in every unit (`2.5 KB`, `2 MB`, `120 MB`).

**Fixed**

- The status bar could show the previous section after jumping to a heading
  in a Markdown file.
- Clicking the first of several headings in one notebook cell showed the
  cell's last heading.
- Turning off `notebookHeadings.markdown` left the Markdown headings in view.

**Safety**: a marks file with git conflict markers is never overwritten;
git is only run in trusted workspace folders, with `core.fsmonitor` off.

## 1.5.0 — 2026-10-08

- **Status marks**: right-click a heading → **Set Status…** to mark it TODO,
  In progress, To check or Finished. The heading's level shape turns into a
  filled, colored status icon. Headings containing `???` show as In progress
  automatically (setting `notebookHeadings.inProgressMarkers`).
- **Stars**: **Add Star** puts a gold star icon before a heading (a small star
  over its status icon, if it has one) and lists it in a **Starred** group at
  the top of the view.
- **Summaries**: every parent shows the marks below it, at any depth, after
  its cell count, e.g. `○2 ➤1 ✓3 ★2` (○ TODO, ➤ In progress, ? To check,
  ✓ Finished, ★ starred), so they stay visible when the section is collapsed.
  First-level sections also show a 2×2 grid of small status icons for every
  status they hold.
- **Show Marked Headings** (bookmark button in the toolbar): only starred
  headings and open statuses, with their parents.
- Marks are saved in the metadata of the heading's cell, so they travel with
  the notebook; each change is one undoable edit.
- **Copy Section Reference** (right-click a heading): copies the file, heading
  path and cell range, e.g.
  `code/Analysis.ipynb · 2  Analysis › 2.1  Summary · cells 12–30` (line
  range for Markdown), one line per selected heading. AI chat tools such as
  Claude Code see selected text but not selected cells; paste this to tell
  them which section you mean.
- **Copy Section Content**: a section's cells as plain text, code cells fenced
  with their language.
- The Filter Headings button now shows a funnel instead of a magnifier.
- Removed **Copy Heading Path** (Copy Section Reference includes the full
  path) and the **Refresh** command (the view updates by itself).

## 1.4.0 — 2026-10-06

- **Select several sections at once**: the headings view now supports
  multi-selection (`Cmd`/`Ctrl`-click, `Shift`-click). **Select Section**
  selects the cells (or Markdown lines) of every selected heading together,
  merging nested and adjacent sections so no cell is selected twice.
  Following the cursor leaves such a selection alone while you scroll or
  edit, and resumes when you move the cursor in the editor.
- **Copy Heading Text / Copy Heading Path** copy one line per selected heading.
- **Tag several cells at once**: with several cells selected (e.g. after
  Select Section), the Tags button or **Edit Cell Tags…** edits all the
  selected code cells in one undoable change. Tags on every cell start
  checked; tags on only some cells are marked "3/10 cells" and are left as
  they are unless checked.
- **Edit Section Tags…**: right-click a heading (or several) to set tags on
  every code cell of those sections at once; heading and text cells are left
  alone.
- The Tags button now appears on code cells only (and on Markdown cells that
  already have tags), since the offered tags collapse code and outputs.
- The Tags button's count updates after `Cmd+Z` or when another extension
  changes a cell's tags.
- Output sizes under 10 KB show one decimal (`2.5 KB`).
- Simpler tag picker: only the three collapse tags (`hide-output`,
  `hide-input`, `hide-cell`) with short descriptions; other tags a cell
  already has are still listed, and any tag can be typed in.
- Tag picker: text typed to filter the list (e.g. `hide`) is no longer added
  as a tag when it still matches listed tags; only a name that matches none of
  them becomes a new tag.
- Markdown parsing follows CommonMark more closely: a closing `#` needs a
  space before it (`## Learn C#` keeps its `#`), and a code fence is closed
  only by an equal or longer fence of the same character with nothing after
  it.
- Jumping to a heading, Select Section and the copy commands use the
  heading's current position after an edit, even before the tree redraws.

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
