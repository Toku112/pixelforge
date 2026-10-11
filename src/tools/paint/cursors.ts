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

/** The History Brush: the brush with a turning-back arrow. */
export const HISTORY_BRUSH_CURSOR = iconCursor(
  [
    'M20 3.5 11.5 12',
    'M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z',
    'M3.6 6.6a3 3 0 1 0 .9-2.2',
    'M4.3 2.6v1.9h1.9',
  ],
  3,
  20,
);

/** The Art History Brush: the brush with a curl. */
export const ART_HISTORY_CURSOR = iconCursor(
  [
    'M20 3.5 11.5 12',
    'M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z',
    'M3.5 8.5c0-2.8 1.7-5 3.8-5 1.6 0 2.6 1.1 2.6 2.4 0 1.1-.8 1.9-1.8 1.9-.9 0-1.5-.6-1.5-1.4',
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

export const STAMP_CURSOR = iconCursor(
  ['M9 4.5h6v3.5l-1.5 3h-3L9 8Z', 'M5 14.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V16H5Z', 'M5 19.5h14'],
  12,
  20,
);

/** The Paint Bucket: a tipped pail; the hot spot is the bottom of the drop. */
export const BUCKET_CURSOR = iconCursor(
  [
    'M10.5 4 19 12.5l-6.4 6.4a1.6 1.6 0 0 1-2.2 0l-5.8-5.8a1.6 1.6 0 0 1 0-2.2Z',
    'M7.3 8.2C5 5.9 4.4 4 5.4 3s3-.4 5.3 1.9',
    'M5.2 12.2h13.4',
    'M20.5 15c1 1.4 1.6 2.4 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-.8.6-1.8 1.6-3.2Z',
  ],
  20,
  20,
);

/** The Mixer Brush: the brush with a drop of paint beside it. */
export const MIXER_CURSOR = iconCursor(
  [
    'M20 3.5 11.5 12',
    'M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z',
    'M18 13.5c1.1 1.5 1.7 2.6 1.7 3.4a1.7 1.7 0 0 1-3.4 0c0-.8.6-1.9 1.7-3.4Z',
  ],
  3,
  20,
);

/** Alt with the Mixer Brush: a target for loading the brush from the image; the hot spot is its centre. */
export const MIXER_LOAD_CURSOR = iconCursor(
  ['M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 1 0 0-15Z', 'M12 2v5M12 17v5M2 12h5M17 12h5'],
  12,
  12,
);

/** Dodge: a round paddle on a handle; the hot spot is the paddle's centre. */
const DODGE_PATHS = ['M14 3a5 5 0 1 0 0 10 5 5 0 1 0 0-10Z', 'm10.5 11.5-7 9'];
export const DODGE_CURSOR = iconCursor(DODGE_PATHS, 14, 8);

/** Burn: a flame; the hot spot is its tip. */
const BURN_PATHS = [
  'M12 2.5c3.5 4 6 6.8 6 10.5a6 6 0 0 1-12 0c0-2.3 1.2-4.1 2.6-5.6.1 1.6.8 2.8 2 3.4-.3-3 .4-5.6 1.4-8.3Z',
  'M12 20.5a2.6 2.6 0 0 1-2.6-2.6c0-1.6 1.2-2.6 2.6-4.2 1.4 1.6 2.6 2.6 2.6 4.2a2.6 2.6 0 0 1-2.6 2.6Z',
];
export const BURN_CURSOR = iconCursor(BURN_PATHS, 12, 3);

/** Sponge: a sponge with pores; the hot spot is its centre. */
const SPONGE_PATHS = [
  'M5 7.5c2-1.5 4-1.5 7 0s5 1.5 7 0v9c-2 1.5-4 1.5-7 0s-5-1.5-7 0Z',
  'M9 10.5h.01M14 11.5h.01M11 14h.01M16 14.5h.01M8 13.5h.01',
];
export const SPONGE_CURSOR = iconCursor(SPONGE_PATHS, 12, 12);
