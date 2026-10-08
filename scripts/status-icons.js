// Generates the heading icons in media/status/ from STATUSES and STAR_FILL in
// src/marks.js (file names come from iconFile() there):
//   <id>.svg              a filled circle in the status color with a white glyph
//   star.svg              the same for a starred heading (white star on gold)
//   <id>-star.svg         a status icon with a small gold star in its corner
//   group-<bits>.svg      a 2×2 grid of small status icons, one per status found
//                         in a section (bits follow STATUSES order: todo,
//                         doing, question, done)
//   group-<bits>-star.svg the same grid with a small gold star in its middle
// Run `npm run icons` after changing a color or glyph.
'use strict';

const fs = require('fs');
const path = require('path');
const { STATUSES, STAR_FILL } = require('../src/marks');

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

/** Points of a five-pointed star centered on (cx, cy). */
const starPoints = (cx, cy, outer, inner) =>
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');

/** The starred-heading icon: white star on a gold circle. */
const starIcon = `<circle cx="8" cy="8" r="7.5" fill="${STAR_FILL}"/><polygon points="${starPoints(8, 8.4, 4.6, 2)}" fill="#fff" stroke="#fff" stroke-width=".8" stroke-linejoin="round"/>`;

/** A small gold star with a white outline, laid over another icon. */
const starBadge = (cx, cy, r) =>
  `<polygon points="${starPoints(cx, cy, r, r * 0.45)}" fill="${STAR_FILL}" stroke="#fff" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/>`;

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

write('star.svg', starIcon);
for (const s of STATUSES) {
  write(`${s.id}.svg`, icon(s));
  write(`${s.id}-star.svg`, `<g transform="translate(0 1) scale(.94)">${icon(s)}</g>${starBadge(12.4, 3.6, 3.6)}`);
}
for (let mask = 1; mask < 1 << STATUSES.length; mask++) {
  const bits = STATUSES.map((_, i) => ((mask >> i) & 1 ? '1' : '0')).join('');
  const icons = STATUSES.map((s, i) => {
    if (bits[i] !== '1') return '';
    const [x, y] = CELLS[i].map((c) => +(c - 8 * SMALL).toFixed(2));
    return `<g transform="translate(${x} ${y}) scale(${SMALL})">${icon(s, 1.45)}</g>`;
  }).join('');
  write(`group-${bits}.svg`, icons);
  write(`group-${bits}-star.svg`, icons + starBadge(8, 8.2, 3.4));
}
console.log(`Wrote ${count} icons to media/status/`);
