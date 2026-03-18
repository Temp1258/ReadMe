import { describe, it, expect } from 'vitest';
import { findMarkerIndex, startsWithMarker, bytesToHex, extractWebmHeaderFromBlob, CLUSTER_MARKER, EBML_MAGIC } from './webm';

describe('findMarkerIndex', () => {
  it('finds marker at the beginning', () => {
    const buf = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x00, 0x01]);
    expect(findMarkerIndex(buf, CLUSTER_MARKER)).toBe(0);
  });

  it('finds marker in the middle', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x1f, 0x43, 0xb6, 0x75, 0x00]);
    expect(findMarkerIndex(buf, CLUSTER_MARKER)).toBe(2);
  });

  it('returns -1 when marker is not present', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(findMarkerIndex(buf, CLUSTER_MARKER)).toBe(-1);
  });

  it('returns -1 for empty buffer', () => {
    expect(findMarkerIndex(new Uint8Array(0), CLUSTER_MARKER)).toBe(-1);
  });

  it('returns -1 for buffer shorter than marker', () => {
    expect(findMarkerIndex(new Uint8Array([0x1f, 0x43]), CLUSTER_MARKER)).toBe(-1);
  });
});

describe('startsWithMarker', () => {
  it('returns true when buffer starts with EBML magic', () => {
    const buf = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
    expect(startsWithMarker(buf, EBML_MAGIC)).toBe(true);
  });

  it('returns false when buffer does not start with EBML magic', () => {
    const buf = new Uint8Array([0x00, 0x45, 0xdf, 0xa3]);
    expect(startsWithMarker(buf, EBML_MAGIC)).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(startsWithMarker(new Uint8Array(0), EBML_MAGIC)).toBe(false);
  });
});

describe('bytesToHex', () => {
  it('converts bytes to hex string', () => {
    const buf = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    expect(bytesToHex(buf)).toBe('1a 45 df a3');
  });

  it('pads single-digit hex values', () => {
    expect(bytesToHex(new Uint8Array([0x01, 0x0a]))).toBe('01 0a');
  });
});

describe('extractWebmHeaderFromBlob', () => {
  it('extracts header bytes before cluster marker', async () => {
    // Simulate: [header bytes] [cluster marker] [data]
    const header = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    const cluster = new Uint8Array([0x1f, 0x43, 0xb6, 0x75]);
    const data = new Uint8Array([0xaa, 0xbb]);
    const combined = new Uint8Array([...header, ...cluster, ...data]);
    const blob = new Blob([combined]);

    const result = await extractWebmHeaderFromBlob(blob);
    expect(result).not.toBeNull();
    expect(result!.byteLength).toBe(header.byteLength);
    expect(Array.from(result!)).toEqual(Array.from(header));
  });

  it('returns null when no cluster marker found', async () => {
    const blob = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])]);
    const result = await extractWebmHeaderFromBlob(blob);
    expect(result).toBeNull();
  });

  it('returns null for empty blob', async () => {
    const blob = new Blob([new Uint8Array(0)]);
    const result = await extractWebmHeaderFromBlob(blob);
    expect(result).toBeNull();
  });
});
