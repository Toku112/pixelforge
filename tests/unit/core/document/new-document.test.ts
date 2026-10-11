import { describe, expect, it } from 'vitest';
import { DocumentPresetLibrary, RECENT_DOCUMENTS } from '../../../../src/app/document-presets';
import type { PixelLayer } from '../../../../src/core/document/layers';
import {
  DEFAULT_DOCUMENT_PRESET,
  PRESET_CATEGORIES,
  convertSize,
  createNewDocument,
  newDocumentBytes,
  newDocumentProblem,
  pixelSize,
  sameSettings,
  sanitizeNewDocumentSettings,
  sanitizePresets,
  type NewDocumentSettings,
} from '../../../../src/core/document/new-document';

const base: NewDocumentSettings = { ...DEFAULT_DOCUMENT_PRESET.settings };
const RED = { r: 1, g: 0, b: 0 };
const with_ = (changes: Partial<NewDocumentSettings>): NewDocumentSettings => ({ ...base, ...changes });
const background = (doc: ReturnType<typeof createNewDocument>) => doc.root.children[0] as PixelLayer;

describe('File > New settings', () => {
  it('the default size is 7 × 5 in at 300 ppi: 2100 × 1500 px, RGB, 8-bit, white', () => {
    expect(pixelSize(base)).toEqual({ width: 2100, height: 1500 });
    expect(base).toMatchObject({ mode: 'rgb', depth: 8, background: 'white' });
    expect(newDocumentBytes(base)).toBe(2100 * 1500 * 3);
    expect(newDocumentBytes(with_({ depth: 16, background: 'transparent' }))).toBe(2100 * 1500 * 4 * 2);
  });

  it('keeps sizes in their unit, so a resolution change keeps millimetres and pixels as typed', () => {
    const a4 = PRESET_CATEGORIES.find((c) => c.id === 'print')!.presets.find((p) => p.name === 'A4')!.settings;
    expect(pixelSize(a4)).toEqual({ width: 2480, height: 3508 });
    expect(pixelSize({ ...a4, resolution: 150 })).toEqual({ width: 1240, height: 1754 });
    const px = with_({ width: 800, height: 600, unit: 'pixels' });
    expect(pixelSize({ ...px, resolution: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('converts the shown size between units without changing the pixels', () => {
    const cm = convertSize(base, 'centimeters');
    expect(cm.unit).toBe('centimeters');
    expect(cm.width).toBeCloseTo(17.78, 6);
    expect(pixelSize(cm)).toEqual(pixelSize(base));
    const px = convertSize(base, 'pixels');
    expect([px.width, px.height]).toEqual([2100, 1500]);
    expect(convertSize(base, 'inches')).toBe(base);
  });

  it('every preset makes a valid document', () => {
    for (const c of PRESET_CATEGORIES)
      for (const p of c.presets) expect(newDocumentProblem(p.settings), `${c.label}: ${p.name}`).toBeNull();
  });

  it('refuses empty and oversized documents', () => {
    expect(newDocumentProblem(with_({ width: 0 }))).toMatch(/more than 0/);
    expect(newDocumentProblem(with_({ resolution: 0 }))).toMatch(/resolution/);
    expect(newDocumentProblem(with_({ width: 300_001, unit: 'pixels' }))).toMatch(/at most 300,000/);
    expect(() => createNewDocument(with_({ height: Number.NaN }), 'x', RED)).toThrow(/more than 0/);
  });
});

describe('createNewDocument', () => {
  it('an opaque background makes a locked Background layer in that colour', () => {
    const doc = createNewDocument(base, 'Untitled-1', RED);
    expect([doc.name, doc.width, doc.height, doc.resolution, doc.mode, doc.depth]).toEqual([
      'Untitled-1',
      2100,
      1500,
      300,
      'rgb',
      8,
    ]);
    expect(doc.layerCount).toBe(1);
    const layer = background(doc);
    expect(layer.isBackground).toBe(true);
    expect(layer.name).toBe('Background');
    expect(doc.activeLayerId).toBe(layer.id);
    expect(layer.buffer.getPixel(2099, 1499)).toEqual([255, 255, 255]);
    // No pixels are stored for a plain colour.
    expect([...layer.buffer.tiles()]).toHaveLength(0);
  });

  it('Black, the background colour and a custom colour', () => {
    const at = (s: Partial<NewDocumentSettings>) =>
      background(createNewDocument(with_({ ...s, width: 10, height: 10, unit: 'pixels' }), 'x', RED)).buffer.getPixel(
        3,
        3,
      );
    expect(at({ background: 'black' })).toEqual([0, 0, 0]);
    expect(at({ background: 'background' })).toEqual([255, 0, 0]);
    expect(at({ background: 'custom', customColor: { r: 0, g: 0.5, b: 1 } })).toEqual([0, 128, 255]);
  });

  it('Transparent makes an ordinary, empty "Layer 1"', () => {
    const doc = createNewDocument(with_({ background: 'transparent' }), 'x', RED);
    const layer = background(doc);
    expect(layer.isBackground).toBe(false);
    expect(layer.name).toBe('Layer 1');
    expect(layer.buffer.getPixel(5, 5)).toEqual([0, 0, 0, 0]);
  });

  it('Grayscale, 16-bit and 32-bit documents', () => {
    const gray = createNewDocument(with_({ mode: 'grayscale', background: 'background' }), 'x', RED);
    expect(gray.mode).toBe('grayscale');
    expect(background(gray).buffer.getPixel(0, 0)).toEqual([76]); // 0.299 × 255
    const deep = createNewDocument(with_({ depth: 16 }), 'x', RED);
    expect(background(deep).buffer.getPixel(0, 0)).toEqual([65535, 65535, 65535]);
    const hdr = createNewDocument(
      with_({ depth: 32, background: 'custom', customColor: { r: 0.5, g: 0, b: 1 } }),
      'x',
      RED,
    );
    const [r, g, b] = background(hdr).buffer.getPixel(0, 0);
    expect(r).toBeCloseTo(0.214, 3); // linear light
    expect([g, b]).toEqual([0, 1]);
  });
});

describe('stored presets', () => {
  it('keep valid settings and fill in what is missing', () => {
    expect(sanitizeNewDocumentSettings({ ...base, depth: 12, mode: 'cmyk', background: 'sparkly' })).toMatchObject({
      depth: 8,
      mode: 'rgb',
      background: 'white',
    });
    expect(sanitizeNewDocumentSettings({ ...base, unit: 'percent' })).toBeNull();
    expect(sanitizeNewDocumentSettings({ ...base, width: -1 })).toBeNull();
    expect(sanitizeNewDocumentSettings('nonsense')).toBeNull();
    expect(sanitizePresets([{ id: 'a', name: 'A', settings: base }, { id: 'b', settings: base }, null, 'x'])).toEqual([
      { id: 'a', name: 'A', settings: base },
    ]);
  });

  it('settings that make the same document are the same', () => {
    expect(sameSettings(base, { ...base, resolutionUnit: 'ppcm' })).toBe(true);
    expect(sameSettings(base, { ...base, depth: 16 })).toBe(false);
    expect(sameSettings(with_({ background: 'custom' }), with_({ background: 'custom', customColor: RED }))).toBe(
      false,
    );
  });

  it('the library: saved presets by name, Recent newest first without repeats', async () => {
    const lib = new DocumentPresetLibrary(false);
    await lib.ready;
    expect(lib.last()).toBeNull();
    await lib.save({ id: '1', name: 'Mine', settings: base });
    await lib.save({ id: '2', name: 'Mine', settings: with_({ depth: 16 }) });
    expect(lib.saved().map((p) => p.id)).toEqual(['2']);
    await lib.deleteSaved('2');
    expect(lib.saved()).toEqual([]);

    await lib.addRecent({ id: 'a', name: 'Default Size', settings: base });
    await lib.addRecent({ id: 'b', name: 'Custom', settings: with_({ width: 3 }) });
    await lib.addRecent({ id: 'c', name: 'Default Size', settings: base });
    expect(lib.recent().map((p) => p.id)).toEqual(['c', 'b']);
    expect(lib.last()).toEqual(base);
    for (let i = 0; i < RECENT_DOCUMENTS + 5; i++)
      await lib.addRecent({ id: `r${i}`, name: 'Custom', settings: with_({ width: 10 + i }) });
    expect(lib.recent()).toHaveLength(RECENT_DOCUMENTS);
  });
});
