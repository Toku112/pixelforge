//! Image codecs compiled to WebAssembly: PNG, JPEG and WebP decoding, PNG encoding.
//!
//! Decoders produce interleaved samples with straight alpha: 1–4 channels (gray,
//! gray+alpha, RGB, RGBA) at 8 or 16 bits, plus the embedded ICC profile and the
//! resolution when the file records them. JPEG and WebP EXIF orientation is applied,
//! so photos open the right way up (as the reference app does). Decoding never
//! changes colour values: colour management happens elsewhere (Phase 7).

use std::borrow::Cow;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

mod orientation;
pub use orientation::{apply_orientation, exif_orientation};

/// Refuse images whose decoded size would not fit comfortably in WebAssembly memory.
pub const MAX_DECODED_BYTES: usize = 2 * 1024 * 1024 * 1024 - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpeg",
            Format::Webp => "webp",
        }
    }
}

/// Identifies a file format from its first bytes.
pub fn detect(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(Format::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Format::Jpeg)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(Format::Webp)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Samples {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

#[derive(Debug, Clone)]
pub struct Decoded {
    pub format: Format,
    pub width: u32,
    pub height: u32,
    /// 1 = gray, 2 = gray + alpha, 3 = RGB, 4 = RGBA.
    pub channels: u8,
    pub samples: Samples,
    pub icc_profile: Option<Vec<u8>>,
    /// Pixels per inch (x, y), when the file records a physical resolution.
    pub ppi: Option<(f64, f64)>,
}

impl Decoded {
    pub fn depth(&self) -> u8 {
        match self.samples {
            Samples::U8(_) => 8,
            Samples::U16(_) => 16,
        }
    }

    pub fn has_alpha(&self) -> bool {
        self.channels == 2 || self.channels == 4
    }
}

#[derive(Debug, PartialEq)]
pub struct CodecError(pub String);

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(message: impl Into<String>) -> CodecError {
    CodecError(message.into())
}

fn check_size(width: u32, height: u32, bytes_per_pixel: usize) -> Result<(), CodecError> {
    let total = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(bytes_per_pixel));
    match total {
        Some(n) if n <= MAX_DECODED_BYTES => Ok(()),
        _ => Err(err(format!(
            "The image is too large to open ({width} × {height} pixels)"
        ))),
    }
}

/// Decodes PNG, JPEG or WebP, detected from the file contents.
pub fn decode(bytes: &[u8]) -> Result<Decoded, CodecError> {
    match detect(bytes) {
        Some(Format::Png) => decode_png(bytes),
        Some(Format::Jpeg) => decode_jpeg(bytes),
        Some(Format::Webp) => decode_webp(bytes),
        None => Err(err("Unrecognised file format")),
    }
}

pub fn decode_png(bytes: &[u8]) -> Result<Decoded, CodecError> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    // Palettes and tRNS become RGB(A)/gray+alpha; sub-8-bit gray becomes 8-bit. 16-bit stays 16-bit.
    decoder.set_transformations(png::Transformations::EXPAND);
    decoder.set_limits(png::Limits {
        bytes: MAX_DECODED_BYTES,
    });
    let mut reader = decoder.read_info().map_err(|e| err(format!("Invalid PNG: {e}")))?;
    let (width, height) = (reader.info().width, reader.info().height);
    check_size(width, height, 8)?;
    let icc_profile = reader.info().icc_profile.as_ref().map(|p| p.to_vec());
    let ppi = reader.info().pixel_dims.and_then(|d| match d.unit {
        png::Unit::Meter => Some((d.xppu as f64 * 0.0254, d.yppu as f64 * 0.0254)),
        png::Unit::Unspecified => None,
    });
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| err("The image is too large to open"))?;
    let mut buf = vec![0u8; size];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| err(format!("Invalid PNG: {e}")))?;
    buf.truncate(info.buffer_size());
    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err(err("Unexpected palette output")),
    };
    let samples = match info.bit_depth {
        png::BitDepth::Sixteen => Samples::U16(buf.as_chunks::<2>().0.iter().map(|b| u16::from_be_bytes(*b)).collect()),
        png::BitDepth::Eight => Samples::U8(buf),
        other => return Err(err(format!("Unexpected PNG bit depth {other:?}"))),
    };
    Ok(Decoded {
        format: Format::Png,
        width: info.width,
        height: info.height,
        channels,
        samples,
        icc_profile,
        ppi,
    })
}

pub fn decode_jpeg(bytes: &[u8]) -> Result<Decoded, CodecError> {
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;

    let options = DecoderOptions::default()
        .set_max_width(65535)
        .set_max_height(65535)
        .set_strict_mode(false);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(Cursor::new(bytes), options);
    decoder
        .decode_headers()
        .map_err(|e| err(format!("Invalid JPEG: {e:?}")))?;
    let input = decoder
        .input_colorspace()
        .ok_or_else(|| err("Invalid JPEG: missing header"))?;
    let (out, channels) = match input {
        ColorSpace::Luma => (ColorSpace::Luma, 1),
        ColorSpace::YCbCr | ColorSpace::RGB => (ColorSpace::RGB, 3),
        ColorSpace::CMYK | ColorSpace::YCCK => {
            return Err(err(
                "CMYK JPEG files are not supported yet; they will open once CMYK colour management is available",
            ));
        }
        other => return Err(err(format!("Unsupported JPEG colour space {other:?}"))),
    };
    let (width, height) = decoder.dimensions().ok_or_else(|| err("Invalid JPEG: missing size"))?;
    check_size(width as u32, height as u32, channels)?;
    decoder.set_options(options.jpeg_set_out_colorspace(out));
    let pixels = decoder.decode().map_err(|e| err(format!("Invalid JPEG: {e:?}")))?;
    let info = decoder.info().ok_or_else(|| err("Invalid JPEG: missing header"))?;
    let ppi = match info.pixel_density {
        1 if info.x_density > 0 && info.y_density > 0 => Some((info.x_density as f64, info.y_density as f64)),
        2 if info.x_density > 0 && info.y_density > 0 => {
            Some((info.x_density as f64 * 2.54, info.y_density as f64 * 2.54))
        }
        _ => None,
    };
    let orientation = decoder.exif().map(|e| exif_orientation(e)).unwrap_or(1);
    let (pixels, w, h) = apply_orientation(pixels, width as u32, height as u32, channels, orientation);
    Ok(Decoded {
        format: Format::Jpeg,
        width: w,
        height: h,
        channels: channels as u8,
        samples: Samples::U8(pixels),
        icc_profile: decoder.icc_profile(),
        ppi,
    })
}

pub fn decode_webp(bytes: &[u8]) -> Result<Decoded, CodecError> {
    let mut decoder =
        image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|e| err(format!("Invalid WebP: {e}")))?;
    let (width, height) = decoder.dimensions();
    let channels: usize = if decoder.has_alpha() { 4 } else { 3 };
    check_size(width, height, channels)?;
    let size = decoder
        .output_buffer_size()
        .ok_or_else(|| err("The image is too large to open"))?;
    let mut pixels = vec![0u8; size];
    decoder
        .read_image(&mut pixels)
        .map_err(|e| err(format!("Invalid WebP: {e}")))?;
    let icc_profile = decoder.icc_profile().ok().flatten();
    let orientation = decoder
        .exif_metadata()
        .ok()
        .flatten()
        .map(|e| exif_orientation(&e))
        .unwrap_or(1);
    let (pixels, w, h) = apply_orientation(pixels, width, height, channels, orientation);
    Ok(Decoded {
        format: Format::Webp,
        width: w,
        height: h,
        channels: channels as u8,
        samples: Samples::U8(pixels),
        icc_profile,
        ppi: None,
    })
}

/// PNG compression effort, from fastest to smallest.
pub fn compression(level: u8) -> png::Compression {
    match level {
        0 => png::Compression::NoCompression,
        1 => png::Compression::Fastest,
        2 => png::Compression::Fast,
        3 => png::Compression::Balanced,
        _ => png::Compression::High,
    }
}

pub struct PngOptions<'a> {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub ppi: Option<f64>,
    pub icc_profile: Option<&'a [u8]>,
    pub compression: u8,
}

/// Encodes interleaved 8- or 16-bit samples as PNG.
pub fn encode_png(samples: &Samples, options: &PngOptions) -> Result<Vec<u8>, CodecError> {
    let color = match options.channels {
        1 => png::ColorType::Grayscale,
        2 => png::ColorType::GrayscaleAlpha,
        3 => png::ColorType::Rgb,
        4 => png::ColorType::Rgba,
        n => return Err(err(format!("PNG cannot store {n} channels"))),
    };
    let expected = options.width as usize * options.height as usize * options.channels as usize;
    let (depth, raw): (png::BitDepth, Cow<[u8]>) = match samples {
        Samples::U8(v) => (png::BitDepth::Eight, Cow::Borrowed(v.as_slice())),
        Samples::U16(v) => (
            png::BitDepth::Sixteen,
            Cow::Owned(v.iter().flat_map(|s| s.to_be_bytes()).collect()),
        ),
    };
    let count = match samples {
        Samples::U8(v) => v.len(),
        Samples::U16(v) => v.len(),
    };
    if count != expected {
        return Err(err(format!("Expected {expected} samples, got {count}")));
    }

    let mut info = png::Info::with_size(options.width, options.height);
    info.color_type = color;
    info.bit_depth = depth;
    if let Some(ppi) = options.ppi.filter(|p| *p > 0.0) {
        let ppm = (ppi / 0.0254).round() as u32;
        info.pixel_dims = Some(png::PixelDimensions {
            xppu: ppm,
            yppu: ppm,
            unit: png::Unit::Meter,
        });
    }
    if let Some(icc) = options.icc_profile {
        info.icc_profile = Some(Cow::Borrowed(icc));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::with_info(&mut out, info).map_err(|e| err(e.to_string()))?;
        encoder.set_compression(compression(options.compression));
        let mut writer = encoder.write_header().map_err(|e| err(e.to_string()))?;
        writer.write_image_data(&raw).map_err(|e| err(e.to_string()))?;
        writer.finish().map_err(|e| err(e.to_string()))?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// JavaScript bindings
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct DecodedImage {
    inner: Decoded,
}

#[wasm_bindgen]
impl DecodedImage {
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.inner.format.name().to_string()
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height
    }
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u8 {
        self.inner.channels
    }
    #[wasm_bindgen(getter)]
    pub fn depth(&self) -> u8 {
        self.inner.depth()
    }
    /// Pixels per inch, or 0 when the file does not record a resolution.
    #[wasm_bindgen(getter, js_name = ppiX)]
    pub fn ppi_x(&self) -> f64 {
        self.inner.ppi.map(|p| p.0).unwrap_or(0.0)
    }
    #[wasm_bindgen(getter, js_name = ppiY)]
    pub fn ppi_y(&self) -> f64 {
        self.inner.ppi.map(|p| p.1).unwrap_or(0.0)
    }
    #[wasm_bindgen(getter, js_name = iccProfile)]
    pub fn icc_profile(&self) -> Option<Vec<u8>> {
        self.inner.icc_profile.clone()
    }
    /// Moves the 8-bit samples out (empty for 16-bit images).
    #[wasm_bindgen(js_name = takeData8)]
    pub fn take_data8(&mut self) -> Vec<u8> {
        match &mut self.inner.samples {
            Samples::U8(v) => std::mem::take(v),
            Samples::U16(_) => Vec::new(),
        }
    }
    /// Moves the 16-bit samples out (empty for 8-bit images).
    #[wasm_bindgen(js_name = takeData16)]
    pub fn take_data16(&mut self) -> Vec<u16> {
        match &mut self.inner.samples {
            Samples::U16(v) => std::mem::take(v),
            Samples::U8(_) => Vec::new(),
        }
    }
}

#[wasm_bindgen(js_name = detectFormat)]
pub fn js_detect_format(bytes: &[u8]) -> Option<String> {
    detect(bytes).map(|f| f.name().to_string())
}

#[wasm_bindgen(js_name = decodeImage)]
pub fn js_decode_image(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    decode(bytes)
        .map(|inner| DecodedImage { inner })
        .map_err(|e| JsError::new(&e.0))
}

#[allow(clippy::too_many_arguments)]
fn js_encode(
    samples: Samples,
    width: u32,
    height: u32,
    channels: u8,
    ppi: f64,
    icc_profile: Option<Vec<u8>>,
    compression: u8,
) -> Result<Vec<u8>, JsError> {
    let options = PngOptions {
        width,
        height,
        channels,
        ppi: (ppi > 0.0).then_some(ppi),
        icc_profile: icc_profile.as_deref(),
        compression,
    };
    encode_png(&samples, &options).map_err(|e| JsError::new(&e.0))
}

#[wasm_bindgen(js_name = encodePng8)]
pub fn js_encode_png8(
    data: Vec<u8>,
    width: u32,
    height: u32,
    channels: u8,
    ppi: f64,
    icc_profile: Option<Vec<u8>>,
    compression: u8,
) -> Result<Vec<u8>, JsError> {
    js_encode(
        Samples::U8(data),
        width,
        height,
        channels,
        ppi,
        icc_profile,
        compression,
    )
}

#[wasm_bindgen(js_name = encodePng16)]
pub fn js_encode_png16(
    data: Vec<u16>,
    width: u32,
    height: u32,
    channels: u8,
    ppi: f64,
    icc_profile: Option<Vec<u8>>,
    compression: u8,
) -> Result<Vec<u8>, JsError> {
    js_encode(
        Samples::U16(data),
        width,
        height,
        channels,
        ppi,
        icc_profile,
        compression,
    )
}

#[cfg(test)]
mod tests;
