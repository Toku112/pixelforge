# Phase 2 check: painting

Phase 2 (the painting tools) ends with two checks that need a person. The automatic part — a scripted painting
session that is saved as PSD, opened again and replayed step by step — already passes in Chrome, Firefox and Safari's
engine.

## 1. Paint a small picture with your tablet (about 20–30 minutes)

Start the app (`pnpm dev`, then open http://localhost:5173 in Chrome), plug in your pen tablet, and paint something
small — a landscape, a face, a still life, anything. The aim is to find out whether painting _feels_ right, so please
use the tools the way you normally would.

1. **Start:** click **New…** on the start screen (or File > New…). Pick a size — for example Art & Illustration >
   Canvas 4000 × 3000 px — and click **Create**.
2. **Block in:** press **G** for the Gradient tool and drag for a background. Press **B** for the Brush and paint
   large shapes. `[` and `]` change the brush size; number keys set the opacity (1 = 10 %, 0 = 100 %).
3. **Pen pressure:** press **F5** to open Brush Settings. Tick **Shape Dynamics** and set **Size Jitter > Control**
   to **Pen Pressure**. Strokes should now get thinner when you press lightly. Try **Transfer** with Pen Pressure for
   opacity too.
4. **Brushes:** open the Brushes panel (Window > Brushes) and try a few brushes from the dry media, wet media and
   special effects groups.
5. **Blend:** press **Shift+B** until you reach the **Mixer Brush** and smear colours together. Try the Smudge and
   Blur tools (toolbar, below the Gradient tool).
6. **Light and shade:** press **O** for Dodge (lighten) and Burn (darken).
7. **Symmetry:** with the Brush, click the butterfly button in the options bar and choose **Vertical** or
   **Radial…**, press Enter, and paint — your stroke is mirrored.
8. **Fix mistakes:** Ctrl/Cmd+Z undoes; the History panel goes back further. Press **Y** for the History Brush to
   paint an earlier state back in.
9. **Save:** File > Save As…, choose PSD, and keep the file. If you have Photoshop, open it there too.

Please tell me, in your own words:

- Does pressure work? Do strokes start and end smoothly, or do they have gaps, blobs or delays?
- Does anything feel slow (strokes lagging behind the pen, panels slow to respond)?
- Is anything confusing, or behaves differently from what you are used to in Photoshop?
- Did anything go wrong (an error message, a stroke disappearing, a crash)?

Screenshots or the PSD file help a lot. Which tablet and browser you used is useful too.

## 2. Our painting, opened in Photoshop (2 minutes)

1. Open `painting.psd` (in this folder) in Photoshop.
2. It should look like `painting-expected.png` (also in this folder): a blue-to-cream sky with two white streaky
   clouds (the right one has a clean diagonal cut through it), three green hills, a pink flower with eight petals and
   a yellow centre, and a faint band of small flowers along the bottom.
3. The Layers panel should show, from top to bottom:
   - **Texture** — blend mode Multiply, Opacity 50%
   - **Flower**
   - **Hills**
   - **Background** — locked, as usual
4. Tell me anything that looks or is named differently (a screenshot helps).
