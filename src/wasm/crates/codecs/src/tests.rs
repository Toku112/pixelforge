use super::*;

fn png_bytes(
    color: png::ColorType,
    depth: png::BitDepth,
    w: u32,
    h: u32,
    data: &[u8],
    setup: impl FnOnce(&mut png::Info),
) -> Vec<u8> {
    let mut info = png::Info::with_size(w, h);
    info.color_type = color;
    info.bit_depth = depth;
    setup(&mut info);
    let mut out = Vec::new();
    {
        let encoder = png::Encoder::with_info(&mut out, info).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(data).unwrap();
    }
    out
}

#[test]
fn detects_formats_from_magic_bytes() {
    assert_eq!(
        detect(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]),
        Some(Format::Png)
    );
    assert_eq!(detect(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(Format::Jpeg));
    assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 "), Some(Format::Webp));
    assert_eq!(detect(b"GIF89a"), None);
    assert_eq!(decode(b"hello").unwrap_err().0, "Unrecognised file format");
}

#[test]
fn round_trips_png_for_every_channel_count_and_depth() {
    for channels in 1..=4u8 {
        for depth16 in [false, true] {
            let (w, h) = (5u32, 3u32);
            let n = (w * h) as usize * channels as usize;
            let samples = if depth16 {
                Samples::U16((0..n).map(|i| (i * 4099 % 65536) as u16).collect())
            } else {
                Samples::U8((0..n).map(|i| (i * 37 % 256) as u8).collect())
            };
            let icc = b"fake icc profile bytes".to_vec();
            let bytes = encode_png(
                &samples,
                &PngOptions {
                    width: w,
                    height: h,
                    channels,
                    ppi: Some(300.0),
                    icc_profile: Some(&icc),
                    compression: 3,
                },
            )
            .unwrap();
            let decoded = decode(&bytes).unwrap();
            assert_eq!((decoded.width, decoded.height, decoded.channels), (w, h, channels));
            assert_eq!(decoded.samples, samples, "channels {channels}, 16-bit {depth16}");
            assert_eq!(decoded.icc_profile.as_deref(), Some(icc.as_slice()));
            let (px, py) = decoded.ppi.unwrap();
            assert!((px - 300.0).abs() < 0.05 && (py - 300.0).abs() < 0.05, "ppi {px}");
        }
    }
}

#[test]
fn expands_palette_png_with_transparency() {
    let bytes = png_bytes(
        png::ColorType::Indexed,
        png::BitDepth::Eight,
        3,
        1,
        &[0, 1, 2],
        |info| {
            info.palette = Some(Cow::Owned(vec![255, 0, 0, 0, 255, 0, 0, 0, 255]));
            info.trns = Some(Cow::Owned(vec![255, 128]));
        },
    );
    let d = decode(&bytes).unwrap();
    assert_eq!(d.channels, 4);
    assert_eq!(
        d.samples,
        Samples::U8(vec![255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255])
    );
}

#[test]
fn expands_low_bit_depth_gray_png() {
    // 1-bit gray: bits 1,0,1,1 in one byte (row padded).
    let bytes = png_bytes(
        png::ColorType::Grayscale,
        png::BitDepth::One,
        4,
        1,
        &[0b1011_0000],
        |_| {},
    );
    let d = decode(&bytes).unwrap();
    assert_eq!((d.channels, d.depth()), (1, 8));
    assert_eq!(d.samples, Samples::U8(vec![255, 0, 255, 255]));
}

#[test]
fn reports_no_resolution_when_png_has_none() {
    let bytes = png_bytes(png::ColorType::Rgb, png::BitDepth::Eight, 1, 1, &[1, 2, 3], |_| {});
    assert_eq!(decode(&bytes).unwrap().ppi, None);
}

#[test]
fn rejects_truncated_png() {
    let bytes = png_bytes(
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        64,
        64,
        &[7; 64 * 64 * 3],
        |_| {},
    );
    let e = decode(&bytes[..bytes.len() / 2]).unwrap_err();
    assert!(e.0.starts_with("Invalid PNG"), "{}", e.0);
}

#[test]
fn rejects_encode_with_wrong_sample_count() {
    let e = encode_png(
        &Samples::U8(vec![0; 5]),
        &PngOptions {
            width: 2,
            height: 1,
            channels: 3,
            ppi: None,
            icc_profile: None,
            compression: 3,
        },
    )
    .unwrap_err();
    assert_eq!(e.0, "Expected 6 samples, got 5");
}

#[test]
fn decodes_lossless_webp_with_and_without_alpha() {
    for (color, channels) in [
        (image_webp::ColorType::Rgba8, 4usize),
        (image_webp::ColorType::Rgb8, 3usize),
    ] {
        let (w, h) = (6u32, 4u32);
        let data: Vec<u8> = (0..(w * h) as usize * channels).map(|i| (i * 13 % 256) as u8).collect();
        let mut bytes = Vec::new();
        image_webp::WebPEncoder::new(&mut bytes)
            .encode(&data, w, h, color)
            .unwrap();
        let d = decode(&bytes).unwrap();
        assert_eq!(
            (d.format, d.width, d.height, d.channels as usize),
            (Format::Webp, w, h, channels)
        );
        assert_eq!(d.samples, Samples::U8(data));
    }
}

/// A 3×2 image whose pixels are their own index (1 channel).
fn grid() -> Vec<u8> {
    vec![0, 1, 2, 3, 4, 5]
}

#[test]
fn applies_all_eight_exif_orientations() {
    // Stored:      Display results (row by row):
    //   0 1 2
    //   3 4 5
    let cases: [(u16, (u32, u32), Vec<u8>); 8] = [
        (1, (3, 2), vec![0, 1, 2, 3, 4, 5]),
        (2, (3, 2), vec![2, 1, 0, 5, 4, 3]),
        (3, (3, 2), vec![5, 4, 3, 2, 1, 0]),
        (4, (3, 2), vec![3, 4, 5, 0, 1, 2]),
        (5, (2, 3), vec![0, 3, 1, 4, 2, 5]),
        (6, (2, 3), vec![3, 0, 4, 1, 5, 2]),
        (7, (2, 3), vec![5, 2, 4, 1, 3, 0]),
        (8, (2, 3), vec![2, 5, 1, 4, 0, 3]),
    ];
    for (o, (w, h), expected) in cases {
        let (out, ow, oh) = apply_orientation(grid(), 3, 2, 1, o);
        assert_eq!(((ow, oh), out), ((w, h), expected), "orientation {o}");
    }
}

fn exif_block(little: bool, orientation: u16) -> Vec<u8> {
    let mut d = Vec::new();
    let w16 = |d: &mut Vec<u8>, v: u16| d.extend(if little { v.to_le_bytes() } else { v.to_be_bytes() });
    let w32 = |d: &mut Vec<u8>, v: u32| d.extend(if little { v.to_le_bytes() } else { v.to_be_bytes() });
    d.extend(b"Exif\0\0");
    d.extend(if little { b"II" } else { b"MM" });
    w16(&mut d, 42);
    w32(&mut d, 8);
    w16(&mut d, 2); // two entries
    // An unrelated tag first (ImageWidth, LONG).
    w16(&mut d, 0x0100);
    w16(&mut d, 4);
    w32(&mut d, 1);
    w32(&mut d, 640);
    // Orientation, SHORT.
    w16(&mut d, 0x0112);
    w16(&mut d, 3);
    w32(&mut d, 1);
    w16(&mut d, orientation);
    w16(&mut d, 0);
    w32(&mut d, 0); // next IFD
    d
}

#[test]
fn reads_exif_orientation_in_both_byte_orders() {
    assert_eq!(exif_orientation(&exif_block(true, 6)), 6);
    assert_eq!(exif_orientation(&exif_block(false, 8)), 8);
    assert_eq!(exif_orientation(&exif_block(true, 6)[6..]), 6); // without the Exif prefix
    assert_eq!(exif_orientation(&exif_block(true, 42)), 1); // out of range
    assert_eq!(exif_orientation(b"garbage"), 1);
    assert_eq!(exif_orientation(&[]), 1);
}
