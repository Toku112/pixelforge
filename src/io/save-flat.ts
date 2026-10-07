/** Saving flattened copies as JPEG or WebP (the work runs in the codec worker). */
import { colorToSamples } from '../core/color/color';
import type { ImageDocument } from '../core/document/document';
import { planFromDocument } from '../core/composite/flatten';
import type { CodecWorkerClient } from '../workers/codec-client';
import { formatById } from './formats';
import { jpegEncoderSettings, type JpegSaveOptions } from './jpeg-options';
import type { WebpSaveOptions } from './webp-options';

/** Flattens the document over the matte colour and encodes it as JPEG. */
export async function encodeDocumentAsJpeg(
  doc: ImageDocument,
  codec: CodecWorkerClient,
  options: JpegSaveOptions,
): Promise<Uint8Array> {
  const restriction = formatById('jpeg').saveRestriction(doc);
  if (restriction) throw new Error(restriction);
  const matte = colorToSamples(options.matte, doc.mode, 8).map((v) => v / 255);
  return codec.flattenToJpeg(planFromDocument(doc), {
    ...jpegEncoderSettings(options),
    matte,
    ppi: doc.resolution,
    iccProfile: doc.iccProfile,
  });
}

/** Flattens the document and encodes it as WebP (lossless, or lossy with the browser's encoder). */
export async function encodeDocumentAsWebp(
  doc: ImageDocument,
  codec: CodecWorkerClient,
  options: WebpSaveOptions,
): Promise<Uint8Array> {
  const restriction = formatById('webp').saveRestriction(doc);
  if (restriction) throw new Error(restriction);
  const plan = planFromDocument(doc);
  return options.lossless
    ? codec.flattenToWebpLossless(plan, { iccProfile: doc.iccProfile })
    : codec.flattenToWebpLossy(plan, { quality: options.quality / 100, iccProfile: doc.iccProfile });
}
