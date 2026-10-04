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
npm run package        # build releases/notebook-headings-<version>.vsix
npm run install-local  # build and install in one step (needs `code` on PATH)
```

## Run and debug

Open the folder in VS Code and press `F5` (*Run Extension*). A second VS Code
window, the Extension Development Host, opens with the extension loaded from
source and `examples/` as its workspace; open `examples/sample.ipynb` or
`examples/sample.md` there. After changing the code, run **Developer: Reload
Window** in that window.

## Making changes

- Parsing, tree building, numbering, color ranks and filtering live in
  `src/headings.js`, which does not use the VS Code API. Put logic changes
  there and add a test to `test/headings.test.js`; `npm test` must pass.
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
- Never change the user's code, text or outputs. The one allowed edit is a
  cell's tags, made only through the tag picker as a single undoable
  `WorkspaceEdit`. Tag picker logic lives in `src/tags.js` (tested in
  `test/tags.test.js`).
- README images and links use relative paths. When the extension is packaged,
  `vsce` rewrites them to `https://github.com/CuihuaXia/notebook-headings/…`
  URLs, because VS Code's extension details page only loads `https:` images.
  Keep new README images under `media/screenshots/`.

## Project layout

```text
notebook-headings/
├── src/
│   ├── extension.js      VS Code integration: tree view, commands, events
│   ├── headings.js       pure logic: parsing, tree, numbering, filter (no VS Code API)
│   └── tags.js           pure logic of the cell tag picker (no VS Code API)
├── test/
│   ├── headings.test.js  unit tests for src/headings.js (`npm test`)
│   └── tags.test.js      unit tests for src/tags.js
├── examples/             sample.ipynb and sample.md to try the extension on
├── media/
│   ├── headings.svg      activity bar icon
│   ├── icon.png          extension icon (Extensions view / Marketplace)
│   └── screenshots/      README screenshots (not packaged in the .vsix)
├── releases/             built .vsix packages
├── .vscode/launch.json   F5 launch configuration
├── l10n/                 runtime text translations (bundle.l10n.zh-cn.json)
├── package.json          extension manifest: commands, menus, settings, colors
├── package.nls*.json     manifest text in English and Chinese
├── CHANGELOG.md
└── LICENSE               MIT
```

Releases are built and published by the maintainer.
