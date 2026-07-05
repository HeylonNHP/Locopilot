/** Detect MIME type from the first bytes of a raw base64 string (no data-URI prefix). */
export function detectImageMimeType(base64: string): string {
  // Decode the first 4 bytes to check magic bytes
  try {
    const bytes = atob(base64.slice(0, 8));
    const b = (i: number) => bytes.codePointAt(i)!;
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
    if (b(0) === 0xff && b(1) === 0xd8) return 'image/jpeg';
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
    if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46) return 'image/webp';
  } catch {
    // Invalid base64 or insufficient bytes — return opaque type so the
    // browser won't attempt to decode it as a specific format
    return 'application/octet-stream';
  }
  // Unknown magic bytes but valid base64 — JPEG is the most common fallback
  return 'image/jpeg';
}
