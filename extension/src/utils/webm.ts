/**
 * Shared WebM binary utilities.
 * Used by both segmentation.ts and live-transcribe.ts.
 */

/** EBML element ID for WebM Cluster. */
export const CLUSTER_MARKER = [0x1f, 0x43, 0xb6, 0x75] as const;

/** EBML magic bytes at start of WebM files. */
export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

/** Maximum bytes to scan when searching for the first Cluster marker. */
export const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

/**
 * Find the first occurrence of a 4-byte marker in a Uint8Array.
 * Returns the byte offset, or -1 if not found.
 */
export function findMarkerIndex(buf: Uint8Array, marker: readonly number[]): number {
  for (let i = 0; i <= buf.length - marker.length; i++) {
    if (buf[i] === marker[0] && buf[i + 1] === marker[1] && buf[i + 2] === marker[2] && buf[i + 3] === marker[3]) {
      return i;
    }
  }
  return -1;
}

/**
 * Check whether a Uint8Array starts with the given byte marker.
 */
export function startsWithMarker(buf: Uint8Array, marker: readonly number[]): boolean {
  if (buf.length < marker.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (buf[i] !== marker[i]) return false;
  }
  return true;
}

/**
 * Hex-dump the first N bytes for logging.
 */
export function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Extract the WebM header (everything before the first Cluster marker)
 * from a recording chunk blob. Returns null if no valid header found.
 */
export async function extractWebmHeaderFromBlob(blob: Blob): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const scanLen = Math.min(bytes.length, HEADER_SCAN_LIMIT_BYTES);
  const idx = findMarkerIndex(bytes.subarray(0, scanLen), CLUSTER_MARKER);

  if (idx < 0 || idx > bytes.length - CLUSTER_MARKER.length) {
    return null;
  }

  const header = new Uint8Array(bytes.slice(0, idx));
  if (header.byteLength > HEADER_SCAN_LIMIT_BYTES) {
    return null;
  }

  return header;
}
