# Notebook Headings

[中文说明](README.zh-CN.md)

A heading outline for **Jupyter notebooks** and **Markdown files** in VS Code,
built for long documents with hundreds of headings.

VS Code's built-in Outline expands everything, which is unusable for a
notebook with 1,000+ headings. Notebook Headings keeps all six heading levels
but opens the tree expanded only to the level you choose (default: `##`), so
you see the structure first and drill down on demand.

<img src="media/screenshots/notebook.png" alt="Notebook Headings view for a Jupyter notebook: numbered, color-coded headings with cell counts and the right-click copy menu" width="800">

## Quick start

- **Install:** search for "Notebook Headings" in the VS Code Extensions view,
  or open its [Marketplace page](https://marketplace.visualstudio.com/items?itemName=cuihuaxia.notebook-headings)
  (see [Installation](#installation)).
- **Share it:** send the Marketplace link (see [Sharing](#sharing)).
- **Build from source or contribute:** see [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

- **Opens collapsed to a chosen level.** All headings are kept; deeper ones
  just start collapsed. *Collapse to Default Level* restores this view at any
  time.
- **Outline numbers** (`1`, `1.2`, `1.2.3`). A single `#` title is left
  unnumbered so the sections start at 1. Toggle from the view toolbar.
- **Level colors and shapes.** `##` red ●, `###` orange ○, `####` blue ■,
  `#####` purple ▲, `######` olive •, with separate light and dark theme
  colors. Every color can be overridden.
- **Cell counts and output sizes.** For notebooks, the grey text after a
  heading shows how many cells the section has and how much output they store,
  e.g. `34 · 2.1 MB`, so you can spot the sections that make a notebook large
  or slow to render.
- **Follows the cursor.** Clicking or scrolling in the document highlights the
  current section without expanding anything you collapsed.
- **Status bar** shows the current section; hover for the full path, click to
  open the view.
- **Filter** (`Cmd+Alt+F` / `Ctrl+Alt+F` in the view): live search with match
  highlighting; matches keep their parent headings visible.
- **Go to Heading** (`Cmd+Alt+O` / `Ctrl+Alt+O` in a notebook or Markdown
  editor): a searchable list of all headings.
- **Select a whole section** (right-click → **Select Section**): selects the
  heading's cells, or lines in Markdown, including all its subsections, so
  you can cut, copy, move, run or delete the section with VS Code's own
  commands.
- **Right-click to copy** a heading's text or its full path, e.g.
  `Title › 2  Analysis › 2.1  Summary`.
- **English and Chinese interface.** Commands, menus, settings and messages
  follow VS Code's display language.
- **One-click cell tags.** A **Tags** button at the bottom right of every
  notebook cell opens a checklist of common tags (`hide-input`,
  `remove-output`, `skip-execution`, …) with a short explanation of each, plus
  any custom tag you type. Tags are stored where Jupyter, Jupyter Book and
  nbconvert read them.
- **Safe by design.** The extension never changes your code, text or outputs.
  The only edit it ever makes is a cell's tags, when you change them in the
  tag picker, and it can be undone with `Cmd+Z`.

Markdown parsing ignores YAML front matter and fenced code blocks, so
`# comments` inside code are never mistaken for headings.

<img src="media/screenshots/markdown.png" alt="Notebook Headings view for a Markdown file; the # comment inside a code block is not listed as a heading" width="800">

## Installation

### From the VS Code Marketplace (recommended)

Extensions view → search for **Notebook Headings** → **Install**, or run:

```bash
code --install-extension cuihuaxia.notebook-headings
```

If `code` is not on your PATH, run **Shell Command: Install 'code' command in
PATH** from the VS Code command palette first (macOS), or use the full path,
e.g. `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`.

Then run **Developer: Reload Window**. A new icon (an "H" with list lines)
appears in the activity bar.

Requires VS Code 1.80 or newer. Works with any notebook opened by the
Jupyter extension, whatever the kernel (Python, R, …).

### From a packaged file

Each version's package is attached to its
[GitHub Release](https://github.com/CuihuaXia/notebook-headings/releases) and
kept in [`releases/`](releases/). Extensions view → `…` menu (top right) →
**Install from VSIX…** → choose the `.vsix`, or:

```bash
code --install-extension releases/notebook-headings-1.0.2.vsix
```

Use this only when the Marketplace is not reachable: an extension installed
from a VSIX is not synced by Settings Sync and is not updated automatically.

To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Moving to another machine

- With **Settings Sync** on, an extension installed from the Marketplace is
  installed and kept up to date on every synced machine automatically.
- Without it, install from the Marketplace once on each machine.
- Your own color, shortcut and other settings live in VS Code's
  `settings.json` / `keybindings.json`, not in this repository; Settings Sync
  carries them too.

## Sharing

Send the [Marketplace link](https://marketplace.visualstudio.com/items?itemName=cuihuaxia.notebook-headings),
or tell people to search for "Notebook Headings" in the Extensions view.
Bug reports and suggestions go to
[GitHub Issues](https://github.com/CuihuaXia/notebook-headings/issues).

## Usage

1. Open a `.ipynb` or `.md` file.
2. Click the Notebook Headings icon in the activity bar.
3. Click a heading to jump to it.

View toolbar, left to right:

| Button | Action |
| --- | --- |
| 🔍 Filter Headings | Type to filter; Enter keeps the filter, Esc cancels. Turns into ✕ (Clear Filter) while filtering. |
| 1≡ Toggle Heading Numbers | Show or hide outline numbers. |
| ⊟ Collapse to Default Level | Restore the default expansion. |
| `…` → Refresh | Re-read headings (normally automatic). |

Right-click a heading for:

- **Select Section**: selects every cell (notebook) or line (Markdown) of the
  section, subsections included, and moves focus to the editor. Then use
  `Cmd+X` / `Cmd+V` to move it, `Cmd+C` to copy it, or run or delete the
  selected cells. If the heading shares its first cell with an earlier
  heading, that cell is selected too and the status bar says so.
- **Copy Heading Text** and **Copy Heading Path**.

To tag a cell, click **Tags** at the bottom right of the cell (it shows the
number of tags once there are some), check or uncheck tags, or type a new one,
then press Enter. **Notebook Headings: Edit Cell Tags…** in the command palette
does the same for the selected cell.

Keyboard shortcuts (change them in *Keyboard Shortcuts* by searching
"Notebook Headings"):

| Shortcut (macOS / Windows, Linux) | Where | Command |
| --- | --- | --- |
| `Cmd+Alt+O` / `Ctrl+Alt+O` | notebook or Markdown editor | Go to Heading… |
| `Cmd+Alt+F` / `Ctrl+Alt+F` | Notebook Headings view | Filter Headings |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `notebookHeadings.defaultExpandLevel` | `2` | Deepest heading level visible when a document opens (1–6). |
| `notebookHeadings.numbering` | `true` | Show outline numbers. |
| `notebookHeadings.numberH1` | `false` | Also number `#` headings. |
| `notebookHeadings.levelColors` | `true` | Color headings and icons by level. |
| `notebookHeadings.showCellCount` | `true` | Show the cell count of each notebook section. |
| `notebookHeadings.showOutputSize` | `true` | Show the total output size of each notebook section. |
| `notebookHeadings.followCursor` | `true` | Highlight the current section in the tree. |
| `notebookHeadings.statusBar` | `true` | Show the current section in the status bar. |
| `notebookHeadings.cellTagButton` | `true` | Show the Tags button on notebook cells. |
| `notebookHeadings.markdown` | `true` | Also handle Markdown files. |

### Custom colors

Colors are theme colors, so they can be overridden in `settings.json`.
`level1` is the shallowest non-title level (usually `##`):

```json
"workbench.colorCustomizations": {
  "notebookHeadings.level1Foreground": "#DC1D04",
  "notebookHeadings.level2Foreground": "#F29F05",
  "notebookHeadings.level3Foreground": "#048ABF",
  "notebookHeadings.level4Foreground": "#5B2A9E",
  "notebookHeadings.level5Foreground": "#A69232",
  "notebookHeadings.level6Foreground": "#B3B3B3"
}
```

To set colors for one theme only, nest them under the theme name, e.g.
`"[Default Dark Modern]": { "notebookHeadings.level1Foreground": "#FF6B4A" }`.

## How levels are counted

- If a document has exactly one `#` heading, it is treated as the page title:
  default color, book icon, no number.
- Every other heading is ranked relative to the shallowest remaining level.
  In a typical notebook that means `##` = level 1 (red), `###` = level 2, …
- Skipped levels are fine: a `####` directly under a `##` becomes its child.
- For notebooks, a section's cell count runs from its heading's cell to the
  next heading of the same or a higher level.

## Known limitations

- VS Code does not let extensions change font size or weight in tree views,
  so levels are distinguished by color, icon shape and indentation only.
- Only ATX headings (`#`, `##`, …) are recognised, not underlined
  (Setext, `===` / `---`) headings or HTML `<h2>` tags.
- Label colors rely on VS Code's file-decoration mechanism, which is why every
  heading has an icon in front of it.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for building from source, debugging and the
project layout.

## License

[MIT](LICENSE) © 2026 Cuihua Xia
