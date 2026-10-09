# Contributing to Notebook Headings

Bug reports, suggestions and pull requests are welcome. For a bug, open an
[issue](https://github.com/CuihuaXia/notebook-headings/issues) with your VS Code
version, the file type (`.ipynb` or `.md`), and a few heading lines that show
the problem.

## Build from source

The extension has no runtime dependencies, so there is no `npm install` step.
Tests need Node.js 18 or newer; packaging needs **Node.js 20 or newer** (the
packaging tool, `vsce`, is fetched on demand with `npx`).

```bash
git clone https://github.com/CuihuaXia/notebook-headings.git
cd notebook-headings
npm test               # run the unit tests
npm run test:integration  # run the integration tests in VS Code (see below)
npm run package        # build releases/notebook-headings-<version>.vsix
npm run install-local  # build and install in one step (needs `code` on PATH)
```

## Run and debug

Open the folder in VS Code and press `F5` (*Run Extension*). A second VS Code
window, the Extension Development Host, opens with the extension loaded from
source and `examples/` as its workspace; open `examples/sample.ipynb` or
`examples/sample.md` there. After changing the code, run **Developer: Reload
Window** in that window.

## Integration tests

`npm run test:integration` starts the VS Code installed on this machine (no
download) with the extension loaded from source, runs
`test/integration/suite.js` inside it, and closes it again. It uses a
throwaway settings folder and copies of the example files, so your own setup
and `examples/` are not touched. Set `VSCODE_BIN` to the VS Code executable if
it is not in the default macOS location. The tests cover what unit tests
cannot: the status bar after a jump, marks written to real documents and
to the Markdown marks file (including renames and outside changes), the mark filter, and Clear Section Outputs. They
reach the extension's internals through the `__test` object returned by
`activate()`, which is not an API.

## Making changes

- Parsing, tree building, numbering, color ranks and filtering live in
  `src/headings.js`, which does not use the VS Code API. Put logic changes
  there and add a test to `test/headings.test.js`; `npm test` must pass.
  When a change touches `src/extension.js`, also run `npm run test:integration`.
- `src/extension.js` holds the VS Code side: the tree view, status bar,
  commands and event handling.
- Commands, menus, keybindings, settings and theme colors are declared in
  `package.json`.
- The interface is localized. Text in `package.json` (command titles, setting
  descriptions, …) is written as `%key%` and defined in `package.nls.json`
  (English) and `package.nls.zh-cn.json` (Chinese). Text shown at runtime goes
  through `vscode.l10n.t('…')` in `src/extension.js`; its Chinese translations
  are in `l10n/bundle.l10n.zh-cn.json`, keyed by the English text. Add a
  translation whenever you add or change user-facing text.
- Never change the user's code or text, and change a notebook only on an
  explicit request: a cell's tags (tag picker) and clearing a section's
  outputs after a confirmation, each a single undoable `WorkspaceEdit`.
  Marks (Set Status, Add Star) never touch documents: they go to the
  project's `.vscode/notebook-headings.json` (`MarksFile` in
  `src/extension.js`); the one exception is removing marks saved by 1.5 from
  a cell's metadata when that cell's marks change. Rules for the marks file,
  each covered by an integration test:
  - never write a marks file that exists but cannot be parsed (e.g. git
    conflict markers): report it and leave it alone;
  - documents that git ignores keep their marks in the workspace storage,
    never in the shared file, so their paths and headings cannot leak into a
    repository;
  - run git only through `git()`, which refuses folders outside a trusted
    workspace folder and turns `core.fsmonitor` off;
  - when moving marks, save under the new name before removing the old one.
  - `.gitignore` changes (Fix .gitignore) are verified with git and rolled
    back when they would not help. Tag picker logic lives in
  `src/tags.js` and mark logic in `src/marks.js` (tested in
  `test/tags.test.js` and `test/marks.test.js`).
- The status and star icons in `media/status/` are generated from the colors
  in `src/marks.js` by `scripts/status-icons.js`. After changing a color or a
  glyph, run `npm run icons`; `npm test` checks that the files match.
- README images and links use relative paths. When the extension is packaged,
  `vsce` rewrites them to `https://github.com/CuihuaXia/notebook-headings/…`
  URLs, because VS Code's extension details page only loads `https:` images.
  Keep new README images under `media/screenshots/`.

## Updating the screenshots

`examples/showcase.ipynb` is made for the README screenshots: it has real
outputs, every status, stars and cell tags. In VS Code, choose the
**Screenshots (no other extensions)** launch configuration and press `F5`;
the window opens the showcase with only this extension loaded, so no other
extension's decorations or status bar items get into the picture. Size the
window to about 1600×1000, take the screenshots, and save them over
`media/screenshots/notebook.png` and `markdown.png`.

## Project layout

```text
notebook-headings/
├── src/
│   ├── extension.js      VS Code integration: tree view, commands, events
│   ├── headings.js       pure logic: parsing, tree, numbering, filter (no VS Code API)
│   ├── marks.js          pure logic of heading status and star marks (no VS Code API)
│   └── tags.js           pure logic of the cell tag picker (no VS Code API)
├── test/
│   ├── headings.test.js  unit tests for src/headings.js (`npm test`)
│   ├── marks.test.js     unit tests for src/marks.js
│   ├── tags.test.js      unit tests for src/tags.js
│   └── integration/      tests run inside VS Code (`npm run test:integration`)
├── examples/             sample.ipynb and sample.md to try the extension on;
│                         showcase.ipynb for the README screenshots, with its
│                         marks in examples/.vscode/notebook-headings.json
├── media/
│   ├── headings.svg      activity bar icon
│   ├── icon.png          extension icon (Extensions view / Marketplace)
│   ├── status/           status and star icons (generated, see scripts/)
│   └── screenshots/      README screenshots (not packaged in the .vsix)
├── scripts/
│   └── status-icons.js   generates media/status/ (`npm run icons`)
├── releases/             built .vsix packages
├── .vscode/launch.json   F5 launch configurations (development, screenshots)
├── l10n/                 runtime text translations (bundle.l10n.zh-cn.json)
├── package.json          extension manifest: commands, menus, settings, colors
├── package.nls*.json     manifest text in English and Chinese
├── CHANGELOG.md
└── LICENSE               MIT
```

Releases are built and published by the maintainer.
