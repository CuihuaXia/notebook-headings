// Generates the heading icons in media/status/ from STATUSES and PIN_FILL in
// src/marks.js (file names come from iconFile() there):
//   <id>.svg              a filled circle in the status color with a white glyph
//   pin.svg               the same for a pinned heading (white pin on gold)
//   <id>-pin.svg          a status icon with a small gold pin badge in its corner
//   group-<bits>.svg      a 2×2 grid of small status icons, one per status found
//                         in a section (bits follow STATUSES order: todo,
//                         doing, question, done)
//   group-<bits>-pin.svg  the same grid with a small gold pin badge in its middle
// Run `npm run icons` after changing a color or glyph.
'use strict';

const fs = require('fs');
const path = require('path');
const { STATUSES, PIN_FILL } = require('../src/marks');

const OUT = path.join(__dirname, '..', 'media', 'status');

/**
 * White glyph drawn on top of each status circle (16×16 viewBox). `w` scales
 * the line width: the small copies in the grid icons use bolder lines so the
 * glyph stays readable at half size.
 */
const GLYPHS = {
  todo: (w) => `<circle cx="8" cy="8" r="3.1" stroke="#fff" stroke-width="${1.7 * w}" fill="none"/>`,
  doing: () => '<path d="M6.3 4.9v6.2a.5.5 0 0 0 .77.42l4.6-3.1a.5.5 0 0 0 0-.84l-4.6-3.1a.5.5 0 0 0-.77.42z" fill="#fff"/>',
  question: (w) =>
    `<path d="M6.1 6.3a1.95 1.95 0 1 1 2.75 1.78c-.55.25-.85.68-.85 1.27v.35" stroke="#fff" stroke-width="${1.5 * w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<circle cx="8" cy="11.75" r="${0.95 * w}" fill="#fff"/>`,
  done: (w) => `<path d="M4.8 8.3l2.2 2.2 4.3-4.6" stroke="#fff" stroke-width="${1.6 * w}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
};

/** A white push pin tilted 45°, drawn for a 16×16 circle centered on (8, 8). */
const PIN_GLYPH =
  '<g transform="rotate(45 8 8)"><path d="M5.6 3h4.8l-.55 3.1 1.95 1.9v1.1H4.2V8l1.95-1.9z" fill="#fff"/>' +
  '<path d="M8 9.1v4.1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></g>';

/** The pinned-heading icon: white pin on a gold circle. */
const pinIcon = `<circle cx="8" cy="8" r="7.5" fill="${PIN_FILL}"/>${PIN_GLYPH}`;

/** A small pinned-heading icon with a white outline, laid over another icon. */
const pinBadge = (cx, cy, r) =>
  `<circle cx="${cx}" cy="${cy}" r="${r + 0.6}" fill="#fff"/>` +
  `<g transform="translate(${cx - (8 * r) / 7.5} ${cy - (8 * r) / 7.5}) scale(${r / 7.5})">${pinIcon}</g>`;

/** A full status icon (16×16): filled circle plus white glyph. */
const icon = (s, w = 1) => `<circle cx="8" cy="8" r="7.5" fill="${s.fill}"/>${GLYPHS[s.id](w)}`;

/** Grid icons: each small icon is the full icon scaled to this factor. */
const SMALL = 0.49;

/** Grid cell centers, in STATUSES order: top left, top right, bottom left, bottom right. */
const CELLS = [
  [4.1, 4.1],
  [11.9, 4.1],
  [4.1, 11.9],
  [11.9, 11.9],
];

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>\n`;

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.svg')) fs.unlinkSync(path.join(OUT, f));
let count = 0;
const write = (name, body) => (fs.writeFileSync(path.join(OUT, name), svg(body)), count++);

write('pin.svg', pinIcon);
for (const s of STATUSES) {
  write(`${s.id}.svg`, icon(s));
  write(`${s.id}-pin.svg`, `<g transform="translate(0 1) scale(.94)">${icon(s)}</g>${pinBadge(12.2, 3.8, 3.6)}`);
}
for (let mask = 1; mask < 1 << STATUSES.length; mask++) {
  const bits = STATUSES.map((_, i) => ((mask >> i) & 1 ? '1' : '0')).join('');
  const icons = STATUSES.map((s, i) => {
    if (bits[i] !== '1') return '';
    const [x, y] = CELLS[i].map((c) => +(c - 8 * SMALL).toFixed(2));
    return `<g transform="translate(${x} ${y}) scale(${SMALL})">${icon(s, 1.45)}</g>`;
  }).join('');
  write(`group-${bits}.svg`, icons);
  write(`group-${bits}-pin.svg`, icons + pinBadge(8, 8, 3.4));
}
console.log(`Wrote ${count} icons to media/status/`);
