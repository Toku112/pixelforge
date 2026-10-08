//! Pixel operations compiled to WebAssembly with SIMD, optionally multi-threaded.
//!
//! Buffers are interleaved: per pixel, the colour samples of the document's colour
//! mode followed by an optional alpha sample (docs/FORMAT_NOTES.md §1). Operations
//! work in place and split the buffer into pixel-aligned chunks; with the `threads`
//! feature the chunks are processed in parallel on a rayon pool backed by Web Workers.

pub mod stroke;

use core::fmt;
use core::ops::Not;
use wasm_bindgen::prelude::*;

#[cfg(all(feature = "threads", target_arch = "wasm32"))]
pub use wasm_bindgen_rayon::init_thread_pool;

/// Largest channel count we accept (the PSD format allows up to 56 channels).
pub const MAX_CHANNELS: usize = 56;

/// Pixels per work item; large enough to amortise scheduling, small enough to balance.
const PIXELS_PER_CHUNK: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum PixelError {
    BadChannelCount(usize),
    AlphaWithoutColour,
    LengthNotMultiple { len: usize, channels: usize },
}

impl fmt::Display for PixelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PixelError::BadChannelCount(n) => write!(f, "channel count must be 1..={MAX_CHANNELS}, got {n}"),
            PixelError::AlphaWithoutColour => write!(f, "a buffer with alpha needs at least one colour channel"),
            PixelError::LengthNotMultiple { len, channels } => {
                write!(
                    f,
                    "buffer length {len} is not a multiple of the channel count {channels}"
                )
            }
        }
    }
}

fn validate(len: usize, channels: usize, has_alpha: bool) -> Result<(), PixelError> {
    if channels == 0 || channels > MAX_CHANNELS {
        return Err(PixelError::BadChannelCount(channels));
    }
    if has_alpha && channels < 2 {
        return Err(PixelError::AlphaWithoutColour);
    }
    if !len.is_multiple_of(channels) {
        return Err(PixelError::LengthNotMultiple { len, channels });
    }
    Ok(())
}

fn for_each_chunk<T: Send>(data: &mut [T], channels: usize, f: impl Fn(&mut [T]) + Sync + Send) {
    let chunk = channels * PIXELS_PER_CHUNK;
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(chunk).for_each(f);
    }
    #[cfg(not(feature = "threads"))]
    data.chunks_mut(chunk).for_each(f);
}

/// Inverts colour samples, leaving alpha (the last sample of each pixel) untouched.
/// For unsigned integer samples covering their full range, `max - v` equals `!v`.
/// The fixed-size arms let the compiler emit SIMD code for the common layouts.
fn invert_chunk<T: Copy + Not<Output = T>>(px: &mut [T], channels: usize, has_alpha: bool) {
    if !has_alpha {
        px.iter_mut().for_each(|v| *v = !*v);
        return;
    }
    match channels {
        2 => px.as_chunks_mut::<2>().0.iter_mut().for_each(|p| p[0] = !p[0]),
        4 => px.as_chunks_mut::<4>().0.iter_mut().for_each(|p| {
            p[0] = !p[0];
            p[1] = !p[1];
            p[2] = !p[2];
        }),
        _ => px
            .chunks_exact_mut(channels)
            .for_each(|p| p[..channels - 1].iter_mut().for_each(|v| *v = !*v)),
    }
}

/// Inverts 8-bit interleaved pixels in place.
pub fn invert_u8(data: &mut [u8], channels: usize, has_alpha: bool) -> Result<(), PixelError> {
    validate(data.len(), channels, has_alpha)?;
    for_each_chunk(data, channels, |c| invert_chunk(c, channels, has_alpha));
    Ok(())
}

/// Inverts 16-bit (0–65535) interleaved pixels in place.
pub fn invert_u16(data: &mut [u16], channels: usize, has_alpha: bool) -> Result<(), PixelError> {
    validate(data.len(), channels, has_alpha)?;
    for_each_chunk(data, channels, |c| invert_chunk(c, channels, has_alpha));
    Ok(())
}

// ---------------------------------------------------------------------------
// JavaScript bindings
// ---------------------------------------------------------------------------

/// True when this build was compiled with WebAssembly SIMD.
#[wasm_bindgen(js_name = simdEnabled)]
pub fn simd_enabled() -> bool {
    cfg!(target_feature = "simd128")
}

/// True when this build was compiled with thread support.
#[wasm_bindgen(js_name = threadsEnabled)]
pub fn threads_enabled() -> bool {
    cfg!(feature = "threads")
}

/// Number of worker threads available to parallel operations (1 without threads).
#[wasm_bindgen(js_name = threadCount)]
pub fn thread_count() -> usize {
    #[cfg(feature = "threads")]
    return rayon::current_num_threads();
    #[cfg(not(feature = "threads"))]
    return 1;
}

#[wasm_bindgen(js_name = invertU8)]
pub fn js_invert_u8(data: &mut [u8], channels: usize, has_alpha: bool) -> Result<(), JsError> {
    invert_u8(data, channels, has_alpha).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = invertU16)]
pub fn js_invert_u16(data: &mut [u16], channels: usize, has_alpha: bool) -> Result<(), JsError> {
    invert_u16(data, channels, has_alpha).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverts_rgba8_colour_but_not_alpha() {
        let mut px = vec![0, 128, 255, 77, 10, 20, 30, 0];
        invert_u8(&mut px, 4, true).unwrap();
        assert_eq!(px, vec![255, 127, 0, 77, 245, 235, 225, 0]);
    }

    #[test]
    fn inverts_all_samples_without_alpha() {
        let mut px = vec![0u8, 1, 254, 255];
        invert_u8(&mut px, 1, false).unwrap();
        assert_eq!(px, vec![255, 254, 1, 0]);
    }

    #[test]
    fn inverts_gray_alpha_and_cmyk_alpha() {
        let mut ga = vec![100u8, 200, 0, 50];
        invert_u8(&mut ga, 2, true).unwrap();
        assert_eq!(ga, vec![155, 200, 255, 50]);

        let mut cmyka = vec![0u8, 64, 128, 255, 9];
        invert_u8(&mut cmyka, 5, true).unwrap();
        assert_eq!(cmyka, vec![255, 191, 127, 0, 9]);
    }

    #[test]
    fn inverts_16_bit_full_range() {
        let mut px = vec![0u16, 32768, 65535, 1234];
        invert_u16(&mut px, 4, true).unwrap();
        assert_eq!(px, vec![65535, 32767, 0, 1234]);
    }

    #[test]
    fn double_invert_is_identity_across_chunk_boundaries() {
        let len = 4 * (PIXELS_PER_CHUNK * 3 + 17);
        let original: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        let mut px = original.clone();
        invert_u8(&mut px, 4, true).unwrap();
        assert_ne!(px, original);
        invert_u8(&mut px, 4, true).unwrap();
        assert_eq!(px, original);
    }

    #[test]
    fn rejects_invalid_layouts() {
        assert_eq!(invert_u8(&mut [0; 4], 0, false), Err(PixelError::BadChannelCount(0)));
        assert_eq!(invert_u8(&mut [0; 57], 57, false), Err(PixelError::BadChannelCount(57)));
        assert_eq!(invert_u8(&mut [0; 4], 1, true), Err(PixelError::AlphaWithoutColour));
        assert_eq!(
            invert_u8(&mut [0; 5], 4, true),
            Err(PixelError::LengthNotMultiple { len: 5, channels: 4 })
        );
    }

    #[test]
    fn reports_build_capabilities() {
        assert_eq!(threads_enabled(), cfg!(feature = "threads"));
        assert!(thread_count() >= 1);
    }
}
