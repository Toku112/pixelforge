//! Our own JPEG encoder (ITU-T T.81): baseline with the standard Huffman tables,
//! baseline with tables optimised for the image, or progressive (spectral
//! selection). 8-bit gray or RGB input; RGB is converted to YCbCr (JFIF), with
//! optional 4:2:0 chroma subsampling. Writes JFIF resolution and an ICC profile.
//!
//! The forward DCT is the Arai–Agui–Nakajima factorisation in floating point; its
//! output scale is folded into the quantisation divisors.

use crate::{CodecError, err};

/// Natural (row-major) index of each zigzag position.
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
    47, 55, 62, 63,
];

/// Example quantisation tables of the standard (Annex K.1), natural order.
const LUMA_Q: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
    87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q: [u16; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99,
];

/// The standard's example Huffman tables (Annex K.3): code counts per length 1–16, then symbols.
const DC_LUMA_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
    0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
    0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
    0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
    0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
    0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JpegMode {
    /// One scan, the standard's example Huffman tables.
    Baseline,
    /// One scan, Huffman tables built for this image (smaller files).
    Optimized,
    /// DC first, then the detail in bands (images appear gradually while loading).
    Progressive,
}

pub struct JpegOptions<'a> {
    pub width: u32,
    pub height: u32,
    /// 1 (gray) or 3 (RGB).
    pub channels: u8,
    /// 1 (worst) – 100 (best).
    pub quality: u8,
    /// Halve the colour resolution in both directions (4:2:0); ignored for gray.
    pub subsample: bool,
    pub mode: JpegMode,
    /// Progressive only: 3, 4 or 5 — in how many steps the luminance detail arrives.
    pub scans: u8,
    pub ppi: Option<f64>,
    pub icc_profile: Option<&'a [u8]>,
}

/// Quantisation table for a quality (the usual scaling of the standard tables).
fn scaled_table(base: &[u16; 64], quality: u8) -> [u16; 64] {
    let q = quality.clamp(1, 100) as u32;
    let scale = if q < 50 { 5000 / q } else { 200 - 2 * q };
    let mut out = [0u16; 64];
    for i in 0..64 {
        out[i] = ((base[i] as u32 * scale + 50) / 100).clamp(1, 255) as u16;
    }
    out
}

/// AAN scale factors: cos(kπ/16)·√2 for k > 0.
fn aan_scale() -> [f32; 8] {
    let mut s = [1f32; 8];
    for (k, v) in s.iter_mut().enumerate().skip(1) {
        *v = ((k as f32) * std::f32::consts::PI / 16.0).cos() * std::f32::consts::SQRT_2;
    }
    s
}

/// One 8-point AAN forward DCT, in place over `d[i * stride]`.
#[inline(always)]
fn dct8(d: &mut [f32; 64], o: usize, stride: usize) {
    let x = |i: usize| o + i * stride;
    let t0 = d[x(0)] + d[x(7)];
    let t7 = d[x(0)] - d[x(7)];
    let t1 = d[x(1)] + d[x(6)];
    let t6 = d[x(1)] - d[x(6)];
    let t2 = d[x(2)] + d[x(5)];
    let t5 = d[x(2)] - d[x(5)];
    let t3 = d[x(3)] + d[x(4)];
    let t4 = d[x(3)] - d[x(4)];
    // Even part.
    let t10 = t0 + t3;
    let t13 = t0 - t3;
    let t11 = t1 + t2;
    let t12 = t1 - t2;
    d[x(0)] = t10 + t11;
    d[x(4)] = t10 - t11;
    let z1 = (t12 + t13) * std::f32::consts::FRAC_1_SQRT_2;
    d[x(2)] = t13 + z1;
    d[x(6)] = t13 - z1;
    // Odd part.
    let s10 = t4 + t5;
    let s11 = t5 + t6;
    let s12 = t6 + t7;
    let z5 = (s10 - s12) * 0.382_683_43;
    let z2 = 0.541_196_1 * s10 + z5;
    let z4 = 1.306_563 * s12 + z5;
    let z3 = s11 * std::f32::consts::FRAC_1_SQRT_2;
    let z11 = t7 + z3;
    let z13 = t7 - z3;
    d[x(5)] = z13 + z2;
    d[x(3)] = z13 - z2;
    d[x(1)] = z11 + z4;
    d[x(7)] = z11 - z4;
}

/// Forward DCT of an 8 × 8 block (level-shifted samples), quantised: zigzag order.
fn fdct_quantize(block: &mut [f32; 64], divisors: &[f32; 64], out: &mut [i16; 64]) {
    for r in 0..8 {
        dct8(block, r * 8, 1);
    }
    for c in 0..8 {
        dct8(block, c, 8);
    }
    for (k, &n) in ZIGZAG.iter().enumerate() {
        out[k] = (block[n] / divisors[n]).round() as i16;
    }
}

/// Divisors that undo the AAN scale and apply a quantisation table (natural order).
fn divisors(table: &[u16; 64]) -> [f32; 64] {
    let s = aan_scale();
    let mut d = [0f32; 64];
    for v in 0..8 {
        for u in 0..8 {
            d[v * 8 + u] = table[v * 8 + u] as f32 * s[u] * s[v] * 8.0;
        }
    }
    d
}

struct Component {
    id: u8,
    h: usize,
    v: usize,
    table: usize,
    /// Quantised blocks, zigzag order, in block rows over the MCU-padded area.
    blocks: Vec<[i16; 64]>,
    /// Blocks per row of the padded area.
    bw: usize,
    /// Blocks that hold image data (non-interleaved scans cover only these).
    used_w: usize,
    used_h: usize,
}

/// Number of bits needed for |v| (the JPEG "size category").
#[inline]
fn category(v: i32) -> u8 {
    (32 - v.unsigned_abs().leading_zeros()) as u8
}

/// The low `size` bits that represent `v` (negative values as v − 1).
#[inline]
fn value_bits(v: i32, size: u8) -> u32 {
    if v < 0 {
        (v - 1) as u32 & ((1u32 << size) - 1)
    } else {
        v as u32
    }
}

struct BitWriter {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl BitWriter {
    fn put(&mut self, code: u32, len: u8) {
        if len == 0 {
            return;
        }
        self.acc = (self.acc << len) | (code & ((1u32 << len) - 1));
        self.n += len as u32;
        while self.n >= 8 {
            let byte = (self.acc >> (self.n - 8)) as u8;
            self.out.push(byte);
            if byte == 0xFF {
                self.out.push(0); // byte stuffing
            }
            self.n -= 8;
        }
        self.acc &= (1u32 << self.n).wrapping_sub(1);
    }

    /// Pads the last byte with ones.
    fn flush(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n as u8;
            self.put((1u32 << pad) - 1, pad);
        }
    }
}

/// A Huffman table: BITS/HUFFVAL as written in DHT, and the code/length of every symbol.
#[derive(Clone)]
struct Huffman {
    bits: [u8; 16],
    values: Vec<u8>,
    code: [u32; 256],
    len: [u8; 256],
}

impl Huffman {
    fn new(bits: &[u8; 16], values: &[u8]) -> Huffman {
        let mut h = Huffman {
            bits: *bits,
            values: values.to_vec(),
            code: [0; 256],
            len: [0; 256],
        };
        // Canonical codes: consecutive within a length, doubled between lengths.
        let mut code = 0u32;
        let mut k = 0;
        for (l, &count) in bits.iter().enumerate() {
            for _ in 0..count {
                let s = values[k] as usize;
                h.code[s] = code;
                h.len[s] = (l + 1) as u8;
                code += 1;
                k += 1;
            }
            code <<= 1;
        }
        h
    }

    /// Optimal code lengths (at most 16 bits) for symbol frequencies (T.81 Annex K.2).
    fn optimal(freq: &[u32; 256]) -> Huffman {
        let mut f = [0i64; 257];
        for (i, &v) in freq.iter().enumerate() {
            f[i] = v as i64;
        }
        if freq.iter().all(|&v| v == 0) {
            f[0] = 1; // an unused table still needs one code to be valid
        }
        f[256] = 1; // a reserved symbol, so no code is all ones
        let mut size = [0usize; 257];
        let mut others = [-1i32; 257];
        loop {
            // The two least frequent symbols still in play (ties: the larger index first).
            let mut c1: i32 = -1;
            let mut c2: i32 = -1;
            let mut v1 = i64::MAX;
            let mut v2 = i64::MAX;
            for (i, &fi) in f.iter().enumerate() {
                if fi > 0 && fi <= v1 {
                    v2 = v1;
                    c2 = c1;
                    v1 = fi;
                    c1 = i as i32;
                } else if fi > 0 && fi <= v2 {
                    v2 = fi;
                    c2 = i as i32;
                }
            }
            if c2 < 0 {
                break;
            }
            let (a, b) = (c1 as usize, c2 as usize);
            f[a] += f[b];
            f[b] = 0;
            // Every symbol in either chain gets one bit longer; join the chains.
            let mut i = a;
            size[i] += 1;
            while others[i] >= 0 {
                i = others[i] as usize;
                size[i] += 1;
            }
            others[i] = b as i32;
            let mut j = b;
            size[j] += 1;
            while others[j] >= 0 {
                j = others[j] as usize;
                size[j] += 1;
            }
        }
        // Count codes per length, then limit lengths to 16 bits (Annex K.2 "adjust bits").
        let mut count = [0usize; 33];
        for &s in size.iter() {
            if s > 0 {
                count[s.min(32)] += 1;
            }
        }
        let mut l = 32;
        while l > 16 {
            while count[l] > 0 {
                let mut j = l - 2;
                while count[j] == 0 {
                    j -= 1;
                }
                count[l] -= 2;
                count[l - 1] += 1;
                count[j + 1] += 2;
                count[j] -= 1;
            }
            l -= 1;
        }
        // Remove the reserved symbol's code (the longest).
        let mut l = 16;
        while count[l] == 0 {
            l -= 1;
        }
        count[l] -= 1;
        let mut bits = [0u8; 16];
        for i in 1..=16 {
            bits[i - 1] = count[i] as u8;
        }
        // Symbols by increasing code length (shorter codes for more frequent symbols).
        let mut values = Vec::new();
        for len in 1..=32 {
            for (s, &sz) in size.iter().enumerate().take(256) {
                if sz == len {
                    values.push(s as u8);
                }
            }
        }
        Huffman::new(&bits, &values)
    }

    fn write(&self, w: &mut BitWriter, symbol: u8) {
        w.put(self.code[symbol as usize], self.len[symbol as usize]);
    }
}

/// Where Huffman symbols go: written out, or counted to build optimal tables.
trait Sink {
    fn dc(&mut self, comp: usize, diff: i32);
    /// AC symbol (run << 4 | size) with its value bits.
    fn ac(&mut self, comp: usize, symbol: u8, bits: u32, size: u8);
}

struct Counter<'a> {
    dc: &'a mut [[u32; 256]; 2],
    ac: &'a mut [[u32; 256]; 2],
    tables: &'a [usize],
}

impl Sink for Counter<'_> {
    fn dc(&mut self, comp: usize, diff: i32) {
        self.dc[self.tables[comp]][category(diff) as usize] += 1;
    }
    fn ac(&mut self, comp: usize, symbol: u8, _bits: u32, _size: u8) {
        self.ac[self.tables[comp]][symbol as usize] += 1;
    }
}

struct Writer<'a> {
    w: &'a mut BitWriter,
    dc: &'a [Huffman; 2],
    ac: &'a [Huffman; 2],
    tables: &'a [usize],
}

impl Sink for Writer<'_> {
    fn dc(&mut self, comp: usize, diff: i32) {
        let size = category(diff);
        self.dc[self.tables[comp]].write(self.w, size);
        self.w.put(value_bits(diff, size), size);
    }
    fn ac(&mut self, comp: usize, symbol: u8, bits: u32, size: u8) {
        self.ac[self.tables[comp]].write(self.w, symbol);
        self.w.put(bits, size);
    }
}

/// The AC coefficients ss..=se of a block: zero runs, ZRL, EOB.
fn code_ac(sink: &mut dyn Sink, comp: usize, block: &[i16; 64], ss: usize, se: usize) {
    let mut run = 0u8;
    for &coef in &block[ss..=se] {
        let v = coef as i32;
        if v == 0 {
            run += 1;
            continue;
        }
        while run > 15 {
            sink.ac(comp, 0xF0, 0, 0);
            run -= 16;
        }
        let size = category(v);
        sink.ac(comp, (run << 4) | size, value_bits(v, size), size);
        run = 0;
    }
    if run > 0 {
        sink.ac(comp, 0x00, 0, 0); // end of block (or of band)
    }
}

/// A scan: which components and which coefficients (zigzag positions ss..=se).
struct Scan {
    comps: Vec<usize>,
    ss: usize,
    se: usize,
}

/// Codes one scan's symbols into `sink`.
fn code_scan(sink: &mut dyn Sink, comps: &[Component], scan: &Scan, mcus: (usize, usize)) {
    let mut pred = vec![0i32; comps.len()];
    if scan.comps.len() > 1 {
        // Interleaved: MCU by MCU, each component's h × v blocks.
        for my in 0..mcus.1 {
            for mx in 0..mcus.0 {
                for &ci in &scan.comps {
                    let c = &comps[ci];
                    for by in 0..c.v {
                        for bx in 0..c.h {
                            let block = &c.blocks[(my * c.v + by) * c.bw + mx * c.h + bx];
                            code_block(sink, ci, block, scan, &mut pred[ci]);
                        }
                    }
                }
            }
        }
    } else {
        // One component: its own blocks in raster order, only those holding image data.
        let ci = scan.comps[0];
        let c = &comps[ci];
        for by in 0..c.used_h {
            for bx in 0..c.used_w {
                code_block(sink, ci, &c.blocks[by * c.bw + bx], scan, &mut pred[ci]);
            }
        }
    }
}

fn code_block(sink: &mut dyn Sink, ci: usize, block: &[i16; 64], scan: &Scan, pred: &mut i32) {
    if scan.ss == 0 {
        let dc = block[0] as i32;
        sink.dc(ci, dc - *pred);
        *pred = dc;
    }
    let ss = scan.ss.max(1);
    if scan.se >= ss {
        code_ac(sink, ci, block, ss, scan.se);
    }
}

fn marker(out: &mut Vec<u8>, code: u8, payload: &[u8]) {
    out.extend_from_slice(&[0xFF, code]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
}

fn dht(out: &mut Vec<u8>, class: u8, id: u8, h: &Huffman) {
    let mut p = vec![(class << 4) | id];
    p.extend_from_slice(&h.bits);
    p.extend_from_slice(&h.values);
    marker(out, 0xC4, &p);
}

/// Encodes 8-bit samples as JPEG.
pub fn encode_jpeg(samples: &[u8], options: &JpegOptions) -> Result<Vec<u8>, CodecError> {
    let (w, h) = (options.width as usize, options.height as usize);
    let nc = options.channels as usize;
    if nc != 1 && nc != 3 {
        return Err(err(format!("JPEG cannot store {nc} channels here")));
    }
    if w == 0 || h == 0 || w > 65535 || h > 65535 {
        return Err(err("JPEG images must be 1 to 65535 pixels wide and high"));
    }
    if samples.len() != w * h * nc {
        return Err(err("Wrong number of samples for the JPEG image size"));
    }
    let sub = nc == 3 && options.subsample;
    let (hmax, vmax) = if sub { (2, 2) } else { (1, 1) };
    let mcus = (w.div_ceil(8 * hmax), h.div_ceil(8 * vmax));

    // Colour planes (Y, Cb, Cr or gray), padded to whole MCUs by repeating edges.
    let pw = mcus.0 * 8 * hmax;
    let ph = mcus.1 * 8 * vmax;
    let mut planes = vec![vec![0f32; pw * ph]; nc];
    for y in 0..ph {
        let sy = y.min(h - 1);
        for x in 0..pw {
            let sx = x.min(w - 1);
            let i = (sy * w + sx) * nc;
            let o = y * pw + x;
            if nc == 1 {
                planes[0][o] = samples[i] as f32;
            } else {
                let (r, g, b) = (samples[i] as f32, samples[i + 1] as f32, samples[i + 2] as f32);
                planes[0][o] = 0.299 * r + 0.587 * g + 0.114 * b;
                planes[1][o] = -0.168_735_9 * r - 0.331_264_1 * g + 0.5 * b + 128.0;
                planes[2][o] = 0.5 * r - 0.418_687_6 * g - 0.081_312_4 * b + 128.0;
            }
        }
    }

    let q = [
        scaled_table(&LUMA_Q, options.quality),
        scaled_table(&CHROMA_Q, options.quality),
    ];
    let div = [divisors(&q[0]), divisors(&q[1])];
    let mut comps: Vec<Component> = Vec::new();
    for (ci, plane) in planes.iter().enumerate() {
        let (ch, cv) = if ci == 0 { (hmax, vmax) } else { (1, 1) };
        let step = (hmax / ch, vmax / cv); // subsampling factor
        let cw = pw / step.0;
        let chh = ph / step.1;
        let bw = cw / 8;
        let bh = chh / 8;
        let table = usize::from(ci > 0);
        let mut blocks = vec![[0i16; 64]; bw * bh];
        let mut block = [0f32; 64];
        for by in 0..bh {
            for bx in 0..bw {
                for yy in 0..8 {
                    for xx in 0..8 {
                        let (x, y) = ((bx * 8 + xx) * step.0, (by * 8 + yy) * step.1);
                        let mut v = 0.0;
                        for dy in 0..step.1 {
                            for dx in 0..step.0 {
                                v += plane[(y + dy) * pw + x + dx];
                            }
                        }
                        block[yy * 8 + xx] = v / (step.0 * step.1) as f32 - 128.0;
                    }
                }
                fdct_quantize(&mut block, &div[table], &mut blocks[by * bw + bx]);
            }
        }
        // Image size of this component, in blocks (for non-interleaved scans).
        let used_w = w.div_ceil(step.0).div_ceil(8);
        let used_h = h.div_ceil(step.1).div_ceil(8);
        comps.push(Component {
            id: (ci + 1) as u8,
            h: ch,
            v: cv,
            table,
            blocks,
            bw,
            used_w,
            used_h,
        });
    }
    let tables: Vec<usize> = comps.iter().map(|c| c.table).collect();

    let all: Vec<usize> = (0..nc).collect();
    let scans: Vec<Scan> = match options.mode {
        JpegMode::Baseline | JpegMode::Optimized => vec![Scan {
            comps: all,
            ss: 0,
            se: 63,
        }],
        JpegMode::Progressive => {
            let bands: &[(usize, usize)] = match options.scans {
                0..=3 => &[(1, 5), (6, 63)],
                4 => &[(1, 2), (3, 9), (10, 63)],
                _ => &[(1, 2), (3, 5), (6, 14), (15, 63)],
            };
            let mut s = vec![Scan {
                comps: all,
                ss: 0,
                se: 0,
            }];
            for &(ss, se) in bands {
                s.push(Scan { comps: vec![0], ss, se });
            }
            for ci in 1..nc {
                s.push(Scan {
                    comps: vec![ci],
                    ss: 1,
                    se: 63,
                });
            }
            s
        }
    };

    // Headers.
    let mut out = vec![0xFF, 0xD8];
    let density = options
        .ppi
        .filter(|p| *p > 0.0)
        .map(|p| p.round().clamp(1.0, 65535.0) as u16);
    let mut app0 = b"JFIF\0\x01\x01".to_vec();
    match density {
        Some(d) => {
            app0.push(1); // dots per inch
            app0.extend_from_slice(&d.to_be_bytes());
            app0.extend_from_slice(&d.to_be_bytes());
        }
        None => app0.extend_from_slice(&[0, 0, 1, 0, 1]),
    }
    app0.extend_from_slice(&[0, 0]);
    marker(&mut out, 0xE0, &app0);
    if let Some(icc) = options.icc_profile.filter(|p| !p.is_empty()) {
        const CHUNK: usize = 65519;
        let count = icc.len().div_ceil(CHUNK);
        if count > 255 {
            return Err(err("The ICC profile is too large for a JPEG file"));
        }
        for (i, part) in icc.chunks(CHUNK).enumerate() {
            let mut p = b"ICC_PROFILE\0".to_vec();
            p.push((i + 1) as u8);
            p.push(count as u8);
            p.extend_from_slice(part);
            marker(&mut out, 0xE2, &p);
        }
    }
    for (id, table) in q.iter().enumerate().take(if nc == 1 { 1 } else { 2 }) {
        let mut p = vec![id as u8];
        p.extend(ZIGZAG.iter().map(|&n| table[n] as u8));
        marker(&mut out, 0xDB, &p);
    }
    let mut sof = vec![8];
    sof.extend_from_slice(&(h as u16).to_be_bytes());
    sof.extend_from_slice(&(w as u16).to_be_bytes());
    sof.push(nc as u8);
    for c in &comps {
        sof.extend_from_slice(&[c.id, ((c.h as u8) << 4) | c.v as u8, c.table as u8]);
    }
    let progressive = options.mode == JpegMode::Progressive;
    marker(&mut out, if progressive { 0xC2 } else { 0xC0 }, &sof);

    let standard = [
        Huffman::new(&DC_LUMA_BITS, &DC_VALUES),
        Huffman::new(&DC_CHROMA_BITS, &DC_VALUES),
    ];
    let standard_ac = [
        Huffman::new(&AC_LUMA_BITS, &AC_LUMA_VALUES),
        Huffman::new(&AC_CHROMA_BITS, &AC_CHROMA_VALUES),
    ];
    for scan in &scans {
        // Tables for this scan: the standard ones, or built from its own symbol counts.
        let (dc, ac) = if options.mode == JpegMode::Baseline {
            (standard.clone(), standard_ac.clone())
        } else {
            let mut fdc = [[0u32; 256]; 2];
            let mut fac = [[0u32; 256]; 2];
            code_scan(
                &mut Counter {
                    dc: &mut fdc,
                    ac: &mut fac,
                    tables: &tables,
                },
                &comps,
                scan,
                mcus,
            );
            (
                [Huffman::optimal(&fdc[0]), Huffman::optimal(&fdc[1])],
                [Huffman::optimal(&fac[0]), Huffman::optimal(&fac[1])],
            )
        };
        let used: Vec<usize> = {
            let mut t: Vec<usize> = scan.comps.iter().map(|&c| tables[c]).collect();
            t.dedup();
            t
        };
        for &t in &used {
            if scan.ss == 0 {
                dht(&mut out, 0, t as u8, &dc[t]);
            }
            if scan.se > 0 {
                dht(&mut out, 1, t as u8, &ac[t]);
            }
        }
        let mut sos = vec![scan.comps.len() as u8];
        for &ci in &scan.comps {
            let t = tables[ci] as u8;
            sos.extend_from_slice(&[comps[ci].id, (t << 4) | t]);
        }
        sos.extend_from_slice(&[scan.ss as u8, scan.se as u8, 0]);
        marker(&mut out, 0xDA, &sos);
        let mut w = BitWriter { out, acc: 0, n: 0 };
        code_scan(
            &mut Writer {
                w: &mut w,
                dc: &dc,
                ac: &ac,
                tables: &tables,
            },
            &comps,
            scan,
            mcus,
        );
        w.flush();
        out = w.out;
    }
    out.extend_from_slice(&[0xFF, 0xD9]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The DCT-II by definition, for comparison.
    fn reference_dct(input: &[f32; 64]) -> [f32; 64] {
        let mut out = [0f32; 64];
        let c = |k: usize| if k == 0 { std::f32::consts::FRAC_1_SQRT_2 } else { 1.0 };
        for v in 0..8 {
            for u in 0..8 {
                let mut s = 0.0;
                for y in 0..8 {
                    for x in 0..8 {
                        s += input[y * 8 + x]
                            * (((2 * x + 1) as f32 * u as f32 * std::f32::consts::PI) / 16.0).cos()
                            * (((2 * y + 1) as f32 * v as f32 * std::f32::consts::PI) / 16.0).cos();
                    }
                }
                out[v * 8 + u] = 0.25 * c(u) * c(v) * s;
            }
        }
        out
    }

    #[test]
    fn aan_dct_matches_the_definition() {
        let mut block = [0f32; 64];
        for (i, v) in block.iter_mut().enumerate() {
            *v = ((i * 37 + 11) % 255) as f32 - 128.0;
        }
        let expected = reference_dct(&block);
        let ones = [1u16; 64];
        let mut q = [0i16; 64];
        // Quantising by 1 gives the rounded true coefficients.
        fdct_quantize(&mut block, &divisors(&ones), &mut q);
        for (k, &n) in ZIGZAG.iter().enumerate() {
            assert!((q[k] as f32 - expected[n]).abs() <= 1.0, "coefficient {n}");
        }
    }

    #[test]
    fn optimal_huffman_codes_are_prefix_free_and_at_most_16_bits() {
        let mut freq = [0u32; 256];
        for (i, f) in freq.iter_mut().enumerate().take(200) {
            *f = 1 + (i as u32 * 7919) % 100_000; // skewed, many symbols
        }
        freq[0] = 10_000_000;
        let h = Huffman::optimal(&freq);
        let mut codes: Vec<(u32, u8)> = (0..200).map(|s| (h.code[s], h.len[s])).collect();
        assert!(codes.iter().all(|&(_, l)| (1..=16).contains(&l)));
        codes.sort_by_key(|&(c, l)| (l, c));
        for (i, &(a, la)) in codes.iter().enumerate() {
            for &(b, lb) in &codes[i + 1..] {
                assert!(b >> (lb - la) != a, "a code is the prefix of another");
            }
            assert_ne!(a, (1 << la) - 1, "all-ones code");
        }
    }
}
