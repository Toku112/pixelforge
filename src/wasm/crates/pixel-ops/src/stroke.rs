//! Brush strokes painted into layer tiles: the common case of `core/paint/stroke.ts`
//! (computed round/elliptical tips and sampled tips; Normal, Behind, Clear and erasing;
//! the Opacity limit; the selection; locked transparency), in WebAssembly.
//!
//! The stroke keeps every touched tile's pixels from before the stroke and a coverage
//! value per pixel. Each dab adds `flow × strength × tip` to the coverage
//! (`c ← c + (1 − c)·a`), and the pixel is recomputed from its original value, so one
//! stroke never goes past Opacity. The arithmetic follows the TypeScript renderer
//! step by step (f64, coverage stored as f32) so both paint identical pixels; strokes
//! with what this does not cover (blend modes, texture, dual brush, wet edges, noise,
//! varying colour or opacity) are painted by the TypeScript renderer.

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const TILE: usize = 256;
const TILE_PIXELS: usize = TILE * TILE;

/// A sample type of layer pixels (8-bit, 16-bit, 32-bit float); the painting loops are
/// compiled once per type, so no pixel asks which type it is.
trait Sample: Copy + Send + Sync + 'static {
    fn to_f64(self) -> f64;
    /// From a value already rounded and clamped to the type's range (see `Shading::q`).
    fn from_f64(v: f64) -> Self;
}

impl Sample for u8 {
    #[inline]
    fn to_f64(self) -> f64 {
        self as f64
    }
    #[inline]
    fn from_f64(v: f64) -> Self {
        v as u8
    }
}

impl Sample for u16 {
    #[inline]
    fn to_f64(self) -> f64 {
        self as f64
    }
    #[inline]
    fn from_f64(v: f64) -> Self {
        v as u16
    }
}

impl Sample for f32 {
    #[inline]
    fn to_f64(self) -> f64 {
        self as f64
    }
    #[inline]
    fn from_f64(v: f64) -> Self {
        v as f32
    }
}

struct TileState<T> {
    tx: i32,
    ty: i32,
    original: Vec<T>,
    out: Vec<T>,
    coverage: Vec<f32>,
    /// Per-pixel selection (0–255), or empty with `uniform` for the whole tile.
    selection: Vec<u8>,
    uniform: u8,
}

/// A sampled tip as a pyramid: level 0 is the tip (0–1), each next level half the size.
struct Pyramid {
    levels: Vec<(usize, usize, Vec<f32>)>,
    side: f64,
}

impl Pyramid {
    fn new(width: usize, height: usize, data: &[u8]) -> Pyramid {
        let first: Vec<f32> = data.iter().map(|&v| (v as f64 / 255.0) as f32).collect();
        let mut levels = vec![(width, height, first)];
        loop {
            let (pw, ph, prev) = levels.last().unwrap();
            let (pw, ph) = (*pw, *ph);
            if pw <= 2 && ph <= 2 {
                break;
            }
            let w = pw.div_ceil(2).max(1);
            let h = ph.div_ceil(2).max(1);
            let mut next = vec![0f32; w * h];
            for y in 0..h {
                for x in 0..w {
                    let mut sum = 0f64;
                    let mut n = 0f64;
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let sx = x * 2 + dx;
                            let sy = y * 2 + dy;
                            if sx < pw && sy < ph {
                                sum += prev[sy * pw + sx] as f64;
                                n += 1.0;
                            }
                        }
                    }
                    next[y * w + x] = (sum / n) as f32;
                }
            }
            levels.push((w, h, next));
        }
        Pyramid {
            levels,
            side: width.max(height) as f64,
        }
    }

    /// Bilinear sample of a level at (u, v) in level pixels (centres at +0.5); 0 outside.
    fn sample(&self, level: usize, u: f64, v: f64) -> f64 {
        let (w, h, data) = &self.levels[level];
        let (w, h) = (*w as i64, *h as i64);
        let x = u - 0.5;
        let y = v - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let (x0, y0) = (x0 as i64, y0 as i64);
        let at = |i: i64, j: i64| -> f64 {
            if i < 0 || j < 0 || i >= w || j >= h {
                0.0
            } else {
                data[(j * w + i) as usize] as f64
            }
        };
        at(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + at(x0 + 1, y0) * fx * (1.0 - fy)
            + at(x0, y0 + 1) * (1.0 - fx) * fy
            + at(x0 + 1, y0 + 1) * fx * fy
    }
}

/// The round tip's coverage at distance `d` from the centre (radius `r`, hardness `h`):
/// a solid core and a smoothstep rim at least a pixel wide (as `dabCoverage` in TypeScript).
#[inline]
fn round_coverage(d: f64, r: f64, h: f64) -> f64 {
    if d >= r + 0.5 {
        return 0.0;
    }
    let soft = ((1.0 - h) * r).max(1.0);
    let inner = r - soft;
    if d <= inner - 0.5 {
        return 1.0;
    }
    let t = ((r + 0.5 - d) / (soft + 1.0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    Behind,
    Clear,
    Erase,
}

/// One dab: centre (document px), diameter, strength and pose.
struct Dab {
    x: f64,
    y: f64,
    size: f64,
    strength: f64,
    angle: f64,
    roundness: f64,
    flip_x: bool,
    flip_y: bool,
}

#[wasm_bindgen]
pub struct BrushStroke {
    depth: u8,
    color_channels: usize,
    spp: usize,
    has_alpha: bool,
    color: Vec<f64>,
    opacity: f64,
    flow: f64,
    hardness: f64,
    mode: Mode,
    lock_alpha: bool,
    offset_x: i32,
    offset_y: i32,
    max: f64,
    tip: Option<Pyramid>,
    tiles: Tiles,
    index: HashMap<(i32, i32), usize>,
}

/// Paints dabs into tiles of one sample type; returns which tiles changed.
fn paint_dabs<T: Sample>(
    shading: &Shading,
    tip: Option<&Pyramid>,
    tiles: &mut [TileState<T>],
    dabs: &[f64],
) -> Vec<bool> {
    let mut changed = vec![false; tiles.len()];
    for d in dabs.as_chunks::<8>().0 {
        let dab = Dab {
            x: d[0],
            y: d[1],
            size: d[2],
            strength: d[3],
            angle: d[4],
            roundness: d[5],
            flip_x: d[6] != 0.0,
            flip_y: d[7] != 0.0,
        };
        #[cfg(feature = "threads")]
        {
            use rayon::prelude::*;
            let hits: Vec<bool> = tiles
                .par_iter_mut()
                .map(|tile| paint_tile(shading, tip, &dab, tile))
                .collect();
            for (i, hit) in hits.into_iter().enumerate() {
                changed[i] |= hit;
            }
        }
        #[cfg(not(feature = "threads"))]
        for (i, tile) in tiles.iter_mut().enumerate() {
            changed[i] |= paint_tile(shading, tip, &dab, tile);
        }
    }
    changed
}

fn new_tile<T: Sample>(tx: i32, ty: i32, data: &[T], selection: &[u8], uniform: u8) -> TileState<T> {
    TileState {
        tx,
        ty,
        original: data.to_vec(),
        out: data.to_vec(),
        coverage: vec![0.0; TILE_PIXELS],
        selection: selection.to_vec(),
        uniform,
    }
}

/// The stroke's tiles, all of one sample type.
enum Tiles {
    U8(Vec<TileState<u8>>),
    U16(Vec<TileState<u16>>),
    F32(Vec<TileState<f32>>),
}

/// Paints one dab into one tile (shared by the single- and multi-threaded paths).
fn paint_tile<T: Sample>(s: &Shading, tip: Option<&Pyramid>, d: &Dab, tile: &mut TileState<T>) -> bool {
    if tile.selection.is_empty() && tile.uniform == 0 {
        return false;
    }
    let sampled = tip.is_some();
    let r_box = (d.size / 2.0) * if sampled { std::f64::consts::SQRT_2 } else { 1.0 } + 1.0;
    let bx = (d.x - r_box).floor();
    let by = (d.y - r_box).floor();
    let bw = (d.x + r_box).ceil() - bx;
    let bh = (d.y + r_box).ceil() - by;
    // Layer coordinates of the dab's box, clipped to the tile.
    let lx0 = bx as i64 - s.offset_x as i64;
    let ly0 = by as i64 - s.offset_y as i64;
    let tx0 = tile.tx as i64 * TILE as i64;
    let ty0 = tile.ty as i64 * TILE as i64;
    let x0 = lx0.max(tx0);
    let y0 = ly0.max(ty0);
    let x1 = (lx0 + bw as i64).min(tx0 + TILE as i64);
    let y1 = (ly0 + bh as i64).min(ty0 + TILE as i64);
    if x0 >= x1 || y0 >= y1 {
        return false;
    }
    let amount = (s.flow * d.strength).min(1.0);
    let a = d.angle * std::f64::consts::PI / 180.0;
    let (sin, cos) = (a.sin(), a.cos());
    let scale = tip.map_or(1.0, |t| d.size / t.side);
    let level = tip.map_or(0, |t| {
        ((1.0 / scale).log2().floor().max(0.0) as usize).min(t.levels.len() - 1)
    });
    let r = d.size / 2.0;
    // A plain circle: only the pixels within reach of each row need looking at.
    let circle = !sampled && d.roundness == 1.0;
    let mut any = false;
    for ly in y0..y1 {
        let dy = (ly + s.offset_y as i64) as f64 + 0.5 - d.y;
        let (mut xa, mut xb) = (x0, x1);
        if circle {
            let reach2 = (r + 0.5) * (r + 0.5) - dy * dy;
            if reach2 <= 0.0 {
                continue;
            }
            let reach = reach2.sqrt();
            let cx = d.x - s.offset_x as f64 - 0.5;
            xa = xa.max((cx - reach).floor() as i64);
            xb = xb.min((cx + reach).ceil() as i64 + 1);
        }
        let row = ((ly - ty0) as usize) * TILE;
        for lx in xa..xb {
            let dx = (lx + s.offset_x as i64) as f64 + 0.5 - d.x;
            let mut u = dx * cos - dy * sin;
            let mut v = dx * sin + dy * cos;
            if d.flip_x {
                u = -u;
            }
            if d.flip_y {
                v = -v;
            }
            v /= d.roundness;
            let cov = match tip {
                None => round_coverage((u * u + v * v).sqrt(), r, s.hardness),
                Some(t) => {
                    let f = (1u64 << level) as f64;
                    let (w0, h0, _) = &t.levels[0];
                    t.sample(
                        level,
                        (u / scale + *w0 as f64 / 2.0) / f,
                        (v / scale + *h0 as f64 / 2.0) / f,
                    )
                }
            };
            if cov <= 0.0 {
                continue;
            }
            let p = row + (lx - tx0) as usize;
            let c = tile.coverage[p] as f64;
            let add = cov * amount;
            let next = c + (1.0 - c) * add;
            tile.coverage[p] = next as f32;
            s.shade(tile, p);
            any = true;
        }
    }
    any
}

/// What recomputing a pixel needs (copied out of the stroke so tiles can be painted in parallel).
struct Shading {
    spp: usize,
    color_channels: usize,
    color: Vec<f64>,
    opacity: f64,
    flow: f64,
    hardness: f64,
    mode: Mode,
    keep_alpha: bool,
    max: f64,
    hdr: bool,
    offset_x: i32,
    offset_y: i32,
}

impl Shading {
    /// A sample value: clamped and rounded (as JavaScript's `Math.round`, `floor(v + 0.5)`, which
    /// is also a single WebAssembly instruction), or as it is for 32-bit float.
    #[inline]
    fn q(&self, v: f64) -> f64 {
        if self.hdr {
            v
        } else {
            (v.clamp(0.0, self.max) + 0.5).floor()
        }
    }

    /// Recomputes pixel `p` of a tile from its original value and the stroke's coverage.
    #[inline]
    fn shade<T: Sample>(&self, tile: &mut TileState<T>, p: usize) {
        let sel = if tile.selection.is_empty() {
            1.0
        } else {
            tile.selection[p] as f64 / 255.0
        };
        let e = self.opacity * tile.coverage[p] as f64 * sel;
        let cc = self.color_channels;
        let i = p * self.spp;
        let o = &tile.original[i..i + self.spp];
        let out = &mut tile.out[i..i + self.spp];
        match self.mode {
            Mode::Erase | Mode::Clear => {
                if self.keep_alpha {
                    if self.mode == Mode::Erase {
                        for c in 0..cc {
                            let oc = o[c].to_f64();
                            out[c] = T::from_f64(self.q(oc + (self.color[c] - oc) * e));
                        }
                    }
                    return;
                }
                out[cc] = T::from_f64(self.q(o[cc].to_f64() * (1.0 - e)));
            }
            Mode::Behind => {
                if self.keep_alpha {
                    return;
                }
                let ao = o[cc].to_f64() / self.max;
                let a = ao + e * (1.0 - ao);
                for c in 0..cc {
                    let oc = o[c].to_f64();
                    let v = if a > 0.0 {
                        self.q((oc * ao + self.color[c] * e * (1.0 - ao)) / a)
                    } else {
                        oc
                    };
                    out[c] = T::from_f64(v);
                }
                out[cc] = T::from_f64(self.q(a * self.max));
            }
            Mode::Normal => {
                if self.keep_alpha {
                    for c in 0..cc {
                        let oc = o[c].to_f64();
                        out[c] = T::from_f64(self.q(oc + (self.color[c] - oc) * e));
                    }
                    return;
                }
                let ao = o[cc].to_f64() / self.max;
                let a = e + ao * (1.0 - e);
                for c in 0..cc {
                    let oc = o[c].to_f64();
                    // As the TypeScript renderer: the paint over the pixel (its blend being the colour).
                    let v = (1.0 - ao) * e * self.color[c] + ao * e * self.color[c] + (1.0 - e) * ao * oc;
                    out[c] = T::from_f64(if a > 0.0 { self.q(v / a) } else { oc });
                }
                out[cc] = T::from_f64(self.q(a * self.max));
            }
        }
    }
}

#[wasm_bindgen]
impl BrushStroke {
    /// `mode`: 0 Normal, 1 Behind, 2 Clear, 3 erase (the Eraser). `color`: samples, one per colour channel.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(constructor)]
    pub fn new(
        depth: u8,
        color_channels: u32,
        has_alpha: bool,
        color: &[f64],
        opacity: f64,
        flow: f64,
        hardness: f64,
        mode: u8,
        lock_alpha: bool,
        offset_x: i32,
        offset_y: i32,
    ) -> Result<BrushStroke, JsError> {
        let color_channels = color_channels as usize;
        if !(1..=crate::MAX_CHANNELS).contains(&color_channels) || color.len() != color_channels {
            return Err(JsError::new("brush stroke: bad colour channels"));
        }
        if ![8, 16, 32].contains(&depth) {
            return Err(JsError::new("brush stroke: bad bit depth"));
        }
        let mode = match mode {
            0 => Mode::Normal,
            1 => Mode::Behind,
            2 => Mode::Clear,
            3 => Mode::Erase,
            _ => return Err(JsError::new("brush stroke: unknown mode")),
        };
        Ok(BrushStroke {
            depth,
            color_channels,
            spp: color_channels + usize::from(has_alpha),
            has_alpha,
            color: color.to_vec(),
            opacity,
            flow,
            hardness,
            mode,
            lock_alpha,
            offset_x,
            offset_y,
            max: match depth {
                8 => 255.0,
                16 => 65535.0,
                _ => 1.0,
            },
            tip: None,
            tiles: match depth {
                8 => Tiles::U8(Vec::new()),
                16 => Tiles::U16(Vec::new()),
                _ => Tiles::F32(Vec::new()),
            },
            index: HashMap::new(),
        })
    }

    /// A sampled tip (coverage 0–255, row by row); without one the round tip is used.
    pub fn set_tip(&mut self, width: u32, height: u32, data: &[u8]) -> Result<(), JsError> {
        if width == 0 || height == 0 || data.len() != (width * height) as usize {
            return Err(JsError::new("brush stroke: bad tip"));
        }
        self.tip = Some(Pyramid::new(width as usize, height as usize, data));
        Ok(())
    }

    /// Checks a new tile (size, selection) and returns its index if the stroke has it already.
    fn check_tile(&self, tx: i32, ty: i32, len: usize, selection: &[u8]) -> Result<Option<u32>, JsError> {
        if len != TILE_PIXELS * self.spp {
            return Err(JsError::new("brush stroke: tile size does not match the pixel format"));
        }
        if !selection.is_empty() && selection.len() != TILE_PIXELS {
            return Err(JsError::new("brush stroke: bad selection tile"));
        }
        Ok(self.index.get(&(tx, ty)).map(|&i| i as u32))
    }

    fn added(&mut self, tx: i32, ty: i32, index: usize) -> u32 {
        self.index.insert((tx, ty), index);
        index as u32
    }

    /// Adds a layer tile (layer tile coordinates) the stroke may paint into; returns its index.
    /// `selection`: per-pixel coverage, or empty with `uniform` (0 or 255) for the whole tile.
    pub fn add_tile_u8(
        &mut self,
        tx: i32,
        ty: i32,
        data: &[u8],
        selection: &[u8],
        uniform: u8,
    ) -> Result<u32, JsError> {
        if let Some(i) = self.check_tile(tx, ty, data.len(), selection)? {
            return Ok(i);
        }
        let Tiles::U8(tiles) = &mut self.tiles else {
            return Err(JsError::new("brush stroke: 8-bit tile in a stroke of another depth"));
        };
        tiles.push(new_tile(tx, ty, data, selection, uniform));
        let i = tiles.len() - 1;
        Ok(self.added(tx, ty, i))
    }

    pub fn add_tile_u16(
        &mut self,
        tx: i32,
        ty: i32,
        data: &[u16],
        selection: &[u8],
        uniform: u8,
    ) -> Result<u32, JsError> {
        if let Some(i) = self.check_tile(tx, ty, data.len(), selection)? {
            return Ok(i);
        }
        let Tiles::U16(tiles) = &mut self.tiles else {
            return Err(JsError::new("brush stroke: 16-bit tile in a stroke of another depth"));
        };
        tiles.push(new_tile(tx, ty, data, selection, uniform));
        let i = tiles.len() - 1;
        Ok(self.added(tx, ty, i))
    }

    pub fn add_tile_f32(
        &mut self,
        tx: i32,
        ty: i32,
        data: &[f32],
        selection: &[u8],
        uniform: u8,
    ) -> Result<u32, JsError> {
        if let Some(i) = self.check_tile(tx, ty, data.len(), selection)? {
            return Ok(i);
        }
        let Tiles::F32(tiles) = &mut self.tiles else {
            return Err(JsError::new("brush stroke: 32-bit tile in a stroke of another depth"));
        };
        tiles.push(new_tile(tx, ty, data, selection, uniform));
        let i = tiles.len() - 1;
        Ok(self.added(tx, ty, i))
    }

    fn shading(&self) -> Shading {
        Shading {
            spp: self.spp,
            color_channels: self.color_channels,
            color: self.color.clone(),
            opacity: self.opacity,
            flow: self.flow,
            hardness: self.hardness,
            mode: self.mode,
            keep_alpha: !self.has_alpha || self.lock_alpha,
            max: self.max,
            hdr: self.depth == 32,
            offset_x: self.offset_x,
            offset_y: self.offset_y,
        }
    }

    /// Paints dabs: 8 values each (x, y, size, strength, angle, roundness, flip x, flip y; document
    /// coordinates). Returns the indices of the tiles that changed.
    pub fn apply_dabs(&mut self, dabs: &[f64]) -> Vec<u32> {
        let shading = self.shading();
        let tip = self.tip.as_ref();
        let changed = match &mut self.tiles {
            Tiles::U8(t) => paint_dabs(&shading, tip, t, dabs),
            Tiles::U16(t) => paint_dabs(&shading, tip, t, dabs),
            Tiles::F32(t) => paint_dabs(&shading, tip, t, dabs),
        };
        changed
            .iter()
            .enumerate()
            .filter(|&(_, &hit)| hit)
            .map(|(i, _)| i as u32)
            .collect()
    }

    /// Where a tile's current pixels are in WebAssembly memory (byte offset), so JavaScript can
    /// copy them out with one copy (views of the memory must be made afresh: it may grow).
    pub fn tile_pointer(&self, index: u32) -> Result<usize, JsError> {
        let missing = || JsError::new("brush stroke: no such tile");
        Ok(match &self.tiles {
            Tiles::U8(t) => t.get(index as usize).ok_or_else(missing)?.out.as_ptr() as usize,
            Tiles::U16(t) => t.get(index as usize).ok_or_else(missing)?.out.as_ptr() as usize,
            Tiles::F32(t) => t.get(index as usize).ok_or_else(missing)?.out.as_ptr() as usize,
        })
    }

    /// Copies a tile's current pixels into `out` (the layer's tile array).
    pub fn read_tile_u8(&self, index: u32, out: &mut [u8]) -> Result<(), JsError> {
        match &self.tiles {
            Tiles::U8(t) => copy_out(t, index, out),
            _ => Err(JsError::new("brush stroke: tile format does not match")),
        }
    }

    pub fn read_tile_u16(&self, index: u32, out: &mut [u16]) -> Result<(), JsError> {
        match &self.tiles {
            Tiles::U16(t) => copy_out(t, index, out),
            _ => Err(JsError::new("brush stroke: tile format does not match")),
        }
    }

    pub fn read_tile_f32(&self, index: u32, out: &mut [f32]) -> Result<(), JsError> {
        match &self.tiles {
            Tiles::F32(t) => copy_out(t, index, out),
            _ => Err(JsError::new("brush stroke: tile format does not match")),
        }
    }
}

fn copy_out<T: Sample>(tiles: &[TileState<T>], index: u32, out: &mut [T]) -> Result<(), JsError> {
    let tile = tiles
        .get(index as usize)
        .ok_or_else(|| JsError::new("brush stroke: no such tile"))?;
    if tile.out.len() != out.len() {
        return Err(JsError::new("brush stroke: tile format does not match"));
    }
    out.copy_from_slice(&tile.out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(depth: u8, mode: u8, opacity: f64, flow: f64, hardness: f64) -> BrushStroke {
        BrushStroke::new(
            depth,
            3,
            true,
            &[255.0, 0.0, 0.0],
            opacity,
            flow,
            hardness,
            mode,
            false,
            0,
            0,
        )
        .ok()
        .unwrap()
    }

    fn px(s: &BrushStroke, x: usize, y: usize) -> Vec<f64> {
        let at = (y * TILE + x) * 4;
        match &s.tiles {
            Tiles::U8(t) => t[0].out[at..at + 4].iter().map(|&v| v as f64).collect(),
            Tiles::U16(t) => t[0].out[at..at + 4].iter().map(|&v| v as f64).collect(),
            Tiles::F32(t) => t[0].out[at..at + 4].iter().map(|&v| v as f64).collect(),
        }
    }

    #[test]
    fn paints_never_past_opacity() {
        let mut s = stroke(8, 0, 0.5, 1.0, 1.0);
        s.add_tile_u8(0, 0, &[0u8, 0, 255, 255].repeat(TILE_PIXELS), &[], 255)
            .ok()
            .unwrap();
        let dab = [50.5, 50.5, 10.0, 1.0, 0.0, 1.0, 0.0, 0.0];
        let changed = s.apply_dabs(&[dab, dab, dab].concat());
        assert_eq!(changed, vec![0]);
        assert_eq!(px(&s, 50, 50), vec![128.0, 0.0, 128.0, 255.0]);
        assert_eq!(px(&s, 60, 50), vec![0.0, 0.0, 255.0, 255.0]); // outside the dab
    }

    #[test]
    fn builds_up_with_flow_and_erases() {
        let mut s = stroke(8, 0, 1.0, 0.5, 1.0);
        s.add_tile_u8(0, 0, &[0u8; TILE_PIXELS * 4], &[], 255).ok().unwrap();
        let dab = [20.5, 20.5, 6.0, 1.0, 0.0, 1.0, 0.0, 0.0];
        s.apply_dabs(&dab);
        assert_eq!(px(&s, 20, 20)[3], 128.0);
        s.apply_dabs(&dab);
        assert_eq!(px(&s, 20, 20)[3], 191.0); // 0.75
        let mut e = stroke(8, 3, 1.0, 1.0, 1.0);
        e.add_tile_u8(0, 0, &[10u8, 20, 30, 200].repeat(TILE_PIXELS), &[], 255)
            .ok()
            .unwrap();
        e.apply_dabs(&dab);
        assert_eq!(px(&e, 20, 20)[3], 0.0);
    }

    #[test]
    fn respects_the_selection_and_skips_unselected_tiles() {
        let mut s = stroke(16, 0, 1.0, 1.0, 1.0);
        let mut sel = vec![0u8; TILE_PIXELS];
        sel[20 * TILE + 20] = 255;
        sel[20 * TILE + 21] = 128;
        s.add_tile_u16(0, 0, &[0u16; TILE_PIXELS * 4], &sel, 0).ok().unwrap();
        s.add_tile_u16(1, 0, &[0u16; TILE_PIXELS * 4], &[], 0).ok().unwrap();
        let changed = s.apply_dabs(&[
            20.5, 20.5, 10.0, 1.0, 0.0, 1.0, 0.0, 0.0, 300.0, 20.0, 10.0, 1.0, 0.0, 1.0, 0.0, 0.0,
        ]);
        assert_eq!(changed, vec![0]);
        assert_eq!(px(&s, 20, 20)[3], 65535.0);
        assert_eq!(px(&s, 21, 20)[3], (65535.0f64 * 128.0 / 255.0).round());
        assert_eq!(px(&s, 22, 20)[3], 0.0);
    }

    #[test]
    fn paints_sampled_tips_scaled_to_the_size() {
        let mut s = stroke(8, 0, 1.0, 1.0, 1.0);
        // A 4 × 2 bar tip, painted 8 px wide (4 px tall).
        s.set_tip(4, 2, &[255; 8]).ok().unwrap();
        s.add_tile_u8(0, 0, &[0u8; TILE_PIXELS * 4], &[], 255).ok().unwrap();
        s.apply_dabs(&[40.0, 40.0, 8.0, 1.0, 0.0, 1.0, 0.0, 0.0]);
        assert_eq!(px(&s, 37, 39)[3], 255.0);
        assert_eq!(px(&s, 40, 43)[3], 0.0);
    }
}
