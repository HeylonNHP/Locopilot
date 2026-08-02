/**
 * Detect the MIME type of a base64 image payload by inspecting the leading
 * magic bytes. Centralises the format table so the openai-compatible adapter
 * and the client-side `AttachmentImages` component use the same logic.
 */

import { IMAGE_MAGIC_BYTE_TABLE, type SupportedImageMimeType } from '@/services/capabilityUnions';

/**
 * Sniff the leading bytes of a base64-decoded buffer and return the matching
 * MIME type. Returns `null` when the payload doesn't match any of the
 * formats listed in `SUPPORTED_IMAGE_MIME_TYPES`.
 *
 * Accepts a `Uint8Array` or anything that exposes `Uint8Array`'s `slice`
 * shape (e.g. `Buffer`). The first 12 bytes are checked against the
 * `IMAGE_MAGIC_BYTE_TABLE`.
 */
export function detectImageMimeType(
  bytes: Uint8Array | ArrayBuffer | null
): SupportedImageMimeType | null {
  if (bytes === null) return null;
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (const entry of IMAGE_MAGIC_BYTE_TABLE) {
    if (view.length < entry.prefix.length) continue;
    let match = true;
    for (let i = 0; i < entry.prefix.length; i++) {
      if (view[i] !== entry.prefix[i]) {
        match = false;
        break;
      }
    }
    if (match) return entry.mime;
  }
  return null;
}
