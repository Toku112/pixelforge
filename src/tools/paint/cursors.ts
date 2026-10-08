/**
 * The painting tools' icons as mouse cursors (Preferences > Cursors > Standard):
 * our own drawings (as in the toolbar), black with a white edge so they show on any
 * image, with the hot spot at the brush tip / eraser edge.
 */

function iconCursor(paths: string[], hotX: number, hotY: number): string {
  const body = paths.map((d) => `<path d="${d}"/>`).join('');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="#fff" stroke-width="3.4">${body}</g><g stroke="#000" stroke-width="1.6">${body}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

export const BRUSH_CURSOR = iconCursor(
  [
    'M20 3.5 11.5 12',
    'M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z',
    'm14 9 1.5 1.5',
  ],
  3,
  20,
);

export const EYEDROPPER_CURSOR = iconCursor(
  ['M14.5 4.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3l-2 2-5-5Z', 'm13 8-8.2 8.2-.8 3.8 3.8-.8L16 11'],
  4,
  20,
);

export const ERASER_CURSOR = iconCursor(
  ['m4 15.5 9-9a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8L13 19.5H8Z', 'M8.5 11 13 15.5M8 19.5h12'],
  6,
  18,
);
