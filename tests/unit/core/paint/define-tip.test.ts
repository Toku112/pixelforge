import { describe, expect, it } from 'vitest';
import { planFromDocument } from '../../../../src/core/composite/flatten';
import { tipFromImage } from '../../../../src/core/paint/define-tip';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { createContext, withBackground } from '../helpers';

describe('Define Brush Preset', () => {
  it('turns darkness, opacity and the selection into tip coverage', () => {
    const { doc } = withBackground(createContext({ width: 40, height: 20 }));
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    // Black, mid gray, and half-transparent black pixels over the white Background.
    layer.buffer.writeRegion(
      { x: 0, y: 0, w: 3, h: 1 },
      new Uint8Array([0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 128]),
    );
    const tip = tipFromImage(planFromDocument(doc), { x: 0, y: 0, w: 4, h: 2 }, null, doc.canvasRect);
    expect([...tip.slice(0, 4)]).toEqual([255, 127, 128, 0]); // white Background paints nothing
    // Transparent areas paint nothing either (no Background).
    doc.removeLayer(doc.background!.id);
    const alone = tipFromImage(planFromDocument(doc), { x: 0, y: 0, w: 4, h: 1 }, null, doc.canvasRect);
    expect(alone[3]).toBe(0);
    expect(alone[0]).toBe(255);
    // Only what is selected, softly where the selection is soft.
    const mask = selectShape(null, { kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, 'new', 0, true, doc.canvasRect)!;
    const selected = tipFromImage(planFromDocument(doc), { x: 0, y: 0, w: 3, h: 1 }, mask, doc.canvasRect);
    expect([...selected]).toEqual([255, 0, 0]);
  });
});
