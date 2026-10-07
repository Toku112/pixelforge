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

/// A smooth colour image with some sharp detail (odd size, to test edge padding).
fn photo(w: usize, h: usize, channels: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * channels);
    for y in 0..h {
        for x in 0..w {
            let edge = if (x / 9 + y / 7) % 5 == 0 { 60 } else { 0 };
            let px = [
                ((x * 255) / w) as u8,
                ((y * 255) / h) as u8,
                (128 + edge - (x + y) % 40) as u8,
            ];
            out.extend_from_slice(&px[..channels.min(3)]);
        }
    }
    out
}

fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let mse: f64 = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| (x as f64 - y as f64).powi(2))
        .sum::<f64>()
        / a.len() as f64;
    10.0 * (255.0 * 255.0 / mse.max(1e-9)).log10()
}

fn jpeg_options(w: usize, h: usize, channels: u8, quality: u8, mode: JpegMode) -> JpegOptions<'static> {
    JpegOptions {
        width: w as u32,
        height: h as u32,
        channels,
        quality,
        subsample: false,
        mode,
        scans: 3,
        ppi: Some(300.0),
        icc_profile: None,
    }
}

#[test]
fn jpeg_round_trips_in_every_mode_and_channel_count() {
    let (w, h) = (101, 67);
    for channels in [1u8, 3] {
        let img = photo(w, h, channels as usize);
        let mut sizes = Vec::new();
        for mode in [JpegMode::Baseline, JpegMode::Optimized, JpegMode::Progressive] {
            for scans in [3u8, 4, 5] {
                if mode != JpegMode::Progressive && scans > 3 {
                    continue;
                }
                let options = JpegOptions {
                    scans,
                    ..jpeg_options(w, h, channels, 92, mode)
                };
                let bytes = encode_jpeg(&img, &options).unwrap();
                let decoded = decode(&bytes).unwrap();
                assert_eq!((decoded.width, decoded.height), (w as u32, h as u32));
                assert_eq!(decoded.channels, channels);
                assert_eq!(decoded.ppi, Some((300.0, 300.0)));
                let Samples::U8(out) = decoded.samples else {
                    panic!("8-bit expected")
                };
                let quality = psnr(&img, &out);
                assert!(quality > 36.0, "{mode:?} {channels}ch {scans} scans: PSNR {quality:.1}");
                if scans == 3 {
                    sizes.push(bytes.len());
                }
            }
        }
        assert!(sizes[1] < sizes[0], "optimised tables make smaller files: {sizes:?}");
    }
}

#[test]
fn jpeg_quality_subsampling_and_icc() {
    let (w, h) = (64, 48);
    let img = photo(w, h, 3);
    let low = encode_jpeg(&img, &jpeg_options(w, h, 3, 10, JpegMode::Optimized)).unwrap();
    let high = encode_jpeg(&img, &jpeg_options(w, h, 3, 100, JpegMode::Optimized)).unwrap();
    assert!(low.len() < high.len());
    let decoded_high = decode(&high).unwrap();
    let Samples::U8(out) = decoded_high.samples else {
        panic!()
    };
    assert!(psnr(&img, &out) > 45.0);
    let subsampled = JpegOptions {
        subsample: true,
        ..jpeg_options(w, h, 3, 90, JpegMode::Baseline)
    };
    let profile = vec![7u8; 70_000]; // needs two ICC chunks
    let with_icc = JpegOptions {
        icc_profile: Some(&profile),
        ..subsampled
    };
    let bytes = encode_jpeg(&img, &with_icc).unwrap();
    let decoded = decode(&bytes).unwrap();
    assert_eq!(decoded.icc_profile.as_deref(), Some(profile.as_slice()));
    let Samples::U8(out) = decoded.samples else { panic!() };
    assert!(psnr(&img, &out) > 30.0);
    assert!(encode_jpeg(&img[1..], &jpeg_options(w, h, 3, 90, JpegMode::Baseline)).is_err());
}

#[test]
fn webp_lossless_round_trips_with_icc() {
    let (w, h) = (37, 23);
    for channels in [1u8, 2, 3, 4] {
        let img: Vec<u8> = (0..w * h * channels as usize).map(|i| (i * 31 % 251) as u8).collect();
        let profile = vec![3u8; 500];
        let bytes = encode_webp_lossless(&img, w as u32, h as u32, channels, Some(&profile)).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (w as u32, h as u32));
        assert_eq!(decoded.icc_profile.as_deref(), Some(profile.as_slice()));
        let Samples::U8(out) = decoded.samples else { panic!() };
        // WebP has no gray: gray comes back as RGB(A) with equal channels.
        let expect: Vec<u8> = match channels {
            1 => img.iter().flat_map(|&v| [v, v, v]).collect(),
            2 => img.chunks(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
            _ => img.clone(),
        };
        assert_eq!(out, expect, "{channels} channels");
    }
}
