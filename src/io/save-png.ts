import type { ImageDocument } from '../core/document/document';
import { planFromDocument } from '../engine/cpu/flatten';
import type { CodecWorkerClient } from '../workers/codec-client';
import { formatById } from './formats';

export interface PngSaveOptions {
  /** 0 (none) … 4 (smallest, slowest). Default 3 (balanced). */
  compression?: number;
}

/** Flattens the document (in the codec worker) and encodes it as PNG. */
export async function encodeDocumentAsPng(
  doc: ImageDocument,
  codec: CodecWorkerClient,
  options: PngSaveOptions = {},
): Promise<Uint8Array> {
  const restriction = formatById('png').saveRestriction(doc);
  if (restriction) throw new Error(restriction);
  return codec.flattenToPng(planFromDocument(doc), {
    ppi: doc.resolution,
    iccProfile: doc.iccProfile,
    compression: options.compression ?? 3,
  });
}
