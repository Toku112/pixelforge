//! EXIF orientation: reading the tag and turning stored pixels the right way up.

/// Reads the EXIF Orientation tag (0x0112) from an EXIF block (with or without
/// the "Exif\0\0" prefix). Returns 1 (as stored) when absent or invalid.
pub fn exif_orientation(exif: &[u8]) -> u16 {
    let data = exif.strip_prefix(b"Exif\0\0").unwrap_or(exif);
    read_orientation(data).filter(|o| (1..=8).contains(o)).unwrap_or(1)
}

fn read_orientation(d: &[u8]) -> Option<u16> {
    let little = match d.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u16> {
        let b = d.get(o..o + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |o: usize| -> Option<u32> {
        let b = d.get(o..o + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if little {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for i in 0..count {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry)? == 0x0112 && u16_at(entry + 2)? == 3 {
            return u16_at(entry + 8);
        }
    }
    None
}

/// Applies an EXIF orientation (1–8) to interleaved 8-bit pixels.
/// Returns the new pixels and dimensions (width/height swap for 5–8).
pub fn apply_orientation(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    channels: usize,
    orientation: u16,
) -> (Vec<u8>, u32, u32) {
    if orientation <= 1 || orientation > 8 {
        return (pixels, width, height);
    }
    let (w, h) = (width as usize, height as usize);
    let swap = orientation >= 5;
    let (dw, dh) = if swap { (h, w) } else { (w, h) };
    let mut out = vec![0u8; pixels.len()];
    for dy in 0..dh {
        for dx in 0..dw {
            // Source pixel shown at display position (dx, dy).
            let (sx, sy) = match orientation {
                2 => (w - 1 - dx, dy),
                3 => (w - 1 - dx, h - 1 - dy),
                4 => (dx, h - 1 - dy),
                5 => (dy, dx),
                6 => (dy, h - 1 - dx),
                7 => (w - 1 - dy, h - 1 - dx),
                _ => (w - 1 - dy, dx), // 8
            };
            let s = (sy * w + sx) * channels;
            let d = (dy * dw + dx) * channels;
            out[d..d + channels].copy_from_slice(&pixels[s..s + channels]);
        }
    }
    (out, dw as u32, dh as u32)
}
