import type { RecordingSessionRecord } from '../db/indexeddb';
import { streamRecordingChunksBySession } from '../db/indexeddb';
import {
  MAX_SEGMENT_BYTES,
  HARD_MAX_SEGMENT_BYTES,
  TARGET_SEGMENT_DURATION_MS,
  SEGMENT_TRANSCRIPT_OVERLAP_MS,
} from './constants';
import { transcribeSegmentBlob } from './transcription';
import { state, updateStatus } from './state';
import { getAudioDurationMs } from '../utils/audio-duration';
import { CLUSTER_MARKER, EBML_MAGIC, HEADER_SCAN_LIMIT_BYTES, findMarkerIndex, startsWithMarker, bytesToHex } from '../utils/webm';

type SegmentChunk = {
  blob: Blob;
  bytes: number;
  seq: number;
  startsWithCluster: boolean;
  startOffsetMs: number;
  endOffsetMs: number;
};

type SegmentBlob = {
  blob: Blob;
  headerPrepended: boolean;
  startOffsetMs: number;
  endOffsetMs: number;
  chunks: Array<{
    blob: Blob;
    startOffsetMs: number;
    endOffsetMs: number;
  }>;
};

export async function transcribeRecordingInSegments(recordingSession: RecordingSessionRecord, mimeType: string): Promise<void> {
  let totalSegments = 0;
  let currentSegmentChunks: SegmentChunk[] = [];
  let currentSegmentBytes = 0;
  const segmentBlobs: SegmentBlob[] = [];
  let headerBytes: Uint8Array | null = null;
  let headerExtractionLogged = false;
  let seg2NoHeaderLogged = false;
  let firstChunkSeen = false;
  let headerMarkerIndex = -1;
  let headerScanLen = 0;
  let extractedHeaderLen = 0;
  let previousChunkEndOffsetMs = 0;

  const tryExtractWebmHeaderBytes = async (firstChunkBlob: Blob): Promise<void> => {
    if (headerExtractionLogged) {
      return;
    }

    const firstChunkBytes = new Uint8Array(await firstChunkBlob.arrayBuffer());
    const scanLen = Math.min(firstChunkBytes.length, HEADER_SCAN_LIMIT_BYTES);
    headerScanLen = scanLen;
    const markerIndex = findMarkerIndex(firstChunkBytes.subarray(0, scanLen), CLUSTER_MARKER);
    headerMarkerIndex = markerIndex;
    const markerIndexValid = markerIndex >= 0 && markerIndex <= firstChunkBytes.length - CLUSTER_MARKER.length;

    if (!markerIndexValid) {
      headerBytes = null;
      extractedHeaderLen = 0;
      headerExtractionLogged = true;
      console.info(
        `[segmentation] header disabled reason=cluster marker missing or invalid offset markerIndex=${markerIndex} scanLen=${scanLen}`,
      );
      return;
    }

    const candidateHeaderBytes = firstChunkBytes.slice(0, markerIndex);
    const headerLength = candidateHeaderBytes.byteLength;
    const MAX_HEADER_BYTES = 1024 * 1024;

    if (headerLength > MAX_HEADER_BYTES) {
      headerBytes = null;
      extractedHeaderLen = 0;
      headerExtractionLogged = true;
      console.info(
        `[segmentation] header disabled reason=header length out of bounds bytes=${headerLength} markerIndex=${markerIndex} scanLen=${scanLen}`,
      );
      return;
    }

    const stableHeaderBytes = new Uint8Array(headerLength);
    stableHeaderBytes.set(candidateHeaderBytes);
    headerBytes = stableHeaderBytes;
    extractedHeaderLen = headerLength;
    headerExtractionLogged = true;
    console.info(`[segmentation] header extracted bytes=${headerLength} markerIndex=${markerIndex} scanLen=${scanLen}`);
  };

  const flushSegment = async (flushChunkCount: number = currentSegmentChunks.length): Promise<void> => {
    if (flushChunkCount <= 0 || currentSegmentChunks.length === 0 || currentSegmentBytes === 0) {
      return;
    }

    const segmentChunks = currentSegmentChunks.slice(0, flushChunkCount);
    const remainingChunks = currentSegmentChunks.slice(flushChunkCount);
    const segmentBytesTotal = segmentChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);

    const segIndex = segmentBlobs.length + 1;
    const firstChunkFirst4 = new Uint8Array(await segmentChunks[0].blob.slice(0, 4).arrayBuffer());
    const firstChunkStartsWithEbml = startsWithMarker(firstChunkFirst4, EBML_MAGIC);
    const shouldPrependHeader = segIndex > 1 && headerBytes !== null && !firstChunkStartsWithEbml;

    if (segIndex === 1 && shouldPrependHeader) {
      throw new Error('Invariant violation: seg1 must not prepend header bytes.');
    }

    if (segIndex > 1 && !shouldPrependHeader && headerBytes === null && !seg2NoHeaderLogged) {
      console.info('[segmentation] seg2+ will NOT prepend header (headerBytes unavailable)');
      seg2NoHeaderLogged = true;
    }

    const segmentParts: BlobPart[] = [];
    let headerPrepended = false;

    if (shouldPrependHeader && headerBytes !== null) {
      const stableHeaderArrayBuffer = new ArrayBuffer(headerBytes.byteLength);
      new Uint8Array(stableHeaderArrayBuffer).set(headerBytes);
      segmentParts.push(new Blob([stableHeaderArrayBuffer]));
      headerPrepended = true;
    }
    for (const chunk of segmentChunks) {
      segmentParts.push(chunk.blob);
    }

    let segmentBlob = new Blob(segmentParts, { type: mimeType || 'audio/webm' });
    const segmentBytes = new Uint8Array(await segmentBlob.slice(0, 64).arrayBuffer());

    if (!startsWithMarker(segmentBytes, EBML_MAGIC) && headerBytes !== null) {
      const stableHeaderArrayBuffer = new ArrayBuffer(headerBytes.byteLength);
      new Uint8Array(stableHeaderArrayBuffer).set(headerBytes);
      segmentBlob = new Blob([stableHeaderArrayBuffer, segmentBlob], { type: mimeType || 'audio/webm' });
      headerPrepended = true;
    }

    if (segmentBlob.size > HARD_MAX_SEGMENT_BYTES) {
      throw new Error(
        `Segment ${segIndex} is ${segmentBlob.size} bytes, exceeding hard max segment size ${HARD_MAX_SEGMENT_BYTES} bytes.`,
      );
    }

    const startOffsetMs = segmentChunks[0].startOffsetMs;
    const endOffsetMs = Math.max(startOffsetMs, segmentChunks[segmentChunks.length - 1].endOffsetMs);

    segmentBlobs.push({
      blob: segmentBlob,
      headerPrepended,
      startOffsetMs,
      endOffsetMs,
      chunks: segmentChunks.map((chunk) => ({
        blob: chunk.blob,
        startOffsetMs: chunk.startOffsetMs,
        endOffsetMs: chunk.endOffsetMs,
      })),
    });
    currentSegmentChunks = remainingChunks;
    currentSegmentBytes = currentSegmentBytes - segmentBytesTotal;
  };

  const findLastClusterBoundaryIndex = (): number => {
    for (let idx = currentSegmentChunks.length - 1; idx > 0; idx -= 1) {
      if (currentSegmentChunks[idx].startsWithCluster) {
        return idx;
      }
    }

    return -1;
  };

  const getProjectedSegmentDurationMs = (nextChunkEndOffsetMs: number): number => {
    if (currentSegmentChunks.length === 0) {
      return 0;
    }

    const segmentStartOffsetMs = currentSegmentChunks[0].startOffsetMs;
    return Math.max(0, nextChunkEndOffsetMs - segmentStartOffsetMs);
  };

  await streamRecordingChunksBySession(recordingSession.sessionId, async (chunk) => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      await tryExtractWebmHeaderBytes(chunk.blob);
    }

    const chunkFirst4 = new Uint8Array(await chunk.blob.slice(0, 4).arrayBuffer());
    const chunkStartsWithCluster = startsWithMarker(chunkFirst4, CLUSTER_MARKER);
    const chunkEndOffsetMs = Math.max(0, chunk.createdAt - recordingSession.startTime);
    const chunkStartOffsetMs = Math.max(0, Math.min(previousChunkEndOffsetMs, chunkEndOffsetMs));
    previousChunkEndOffsetMs = chunkEndOffsetMs;

    while (true) {
      const currentSegmentIndex = segmentBlobs.length + 1;
      const reservedHeaderBytes = currentSegmentIndex > 1 && headerBytes ? headerBytes.byteLength : 0;
      const projectedBytes = currentSegmentBytes + reservedHeaderBytes + chunk.bytes;
      const projectedDurationMs = getProjectedSegmentDurationMs(chunkEndOffsetMs);
      const exceedsDurationTarget =
        currentSegmentBytes > 0 && projectedDurationMs >= TARGET_SEGMENT_DURATION_MS;
      const exceedsSoftTarget = currentSegmentBytes > 0 && projectedBytes > MAX_SEGMENT_BYTES;
      const exceedsHardTarget = currentSegmentBytes > 0 && projectedBytes > HARD_MAX_SEGMENT_BYTES;

      if (exceedsDurationTarget) {
        await flushSegment();
        continue;
      }

      if (exceedsSoftTarget && chunkStartsWithCluster) {
        await flushSegment();
        continue;
      }

      if (exceedsHardTarget) {
        if (chunkStartsWithCluster) {
          await flushSegment();
          continue;
        }

        const splitIndex = findLastClusterBoundaryIndex();
        if (splitIndex > 0) {
          await flushSegment(splitIndex);
          continue;
        }

        console.info(
          `[segmentation] hard-max fallback split before chunk=${chunk.seq} without cluster-aligned boundary hardMaxBytes=${HARD_MAX_SEGMENT_BYTES}`,
        );
        await flushSegment();
        continue;
      }

      break;
    }

    const postSplitSegmentIndex = segmentBlobs.length + 1;
    const postSplitReservedHeaderBytes = postSplitSegmentIndex > 1 && headerBytes ? headerBytes.byteLength : 0;

    if (chunk.bytes + postSplitReservedHeaderBytes > HARD_MAX_SEGMENT_BYTES) {
      throw new Error(
        `Chunk ${chunk.seq} is ${chunk.bytes} bytes and cannot fit with required header reservation ${postSplitReservedHeaderBytes} bytes within hard max segment size ${HARD_MAX_SEGMENT_BYTES} bytes.`,
      );
    }

    currentSegmentChunks.push({
      blob: chunk.blob,
      bytes: chunk.bytes,
      seq: chunk.seq,
      startsWithCluster: chunkStartsWithCluster,
      startOffsetMs: chunkStartOffsetMs,
      endOffsetMs: chunkEndOffsetMs,
    });
    currentSegmentBytes += chunk.bytes;
  });

  await flushSegment();
  totalSegments = segmentBlobs.length;

  const buildSegmentBlobFromChunks = async (
    chunks: Array<{ blob: Blob; startOffsetMs: number; endOffsetMs: number }>,
    segmentIndex: number,
  ): Promise<{ blob: Blob; headerPrepended: boolean }> => {
    if (chunks.length === 0) {
      return { blob: new Blob([], { type: mimeType || 'audio/webm' }), headerPrepended: false };
    }

    const firstChunkFirst4 = new Uint8Array(await chunks[0].blob.slice(0, 4).arrayBuffer());
    const firstChunkStartsWithEbml = startsWithMarker(firstChunkFirst4, EBML_MAGIC);
    const shouldPrependHeader = segmentIndex > 1 && headerBytes !== null && !firstChunkStartsWithEbml;
    const parts: BlobPart[] = [];
    let headerPrependedResult = false;

    if (shouldPrependHeader && headerBytes !== null) {
      const stableHeaderArrayBuffer = new ArrayBuffer(headerBytes.byteLength);
      new Uint8Array(stableHeaderArrayBuffer).set(headerBytes);
      parts.push(new Blob([stableHeaderArrayBuffer]));
      headerPrependedResult = true;
    }

    for (const chunk of chunks) {
      parts.push(chunk.blob);
    }

    let blob = new Blob(parts, { type: mimeType || 'audio/webm' });
    const firstBytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());

    if (!startsWithMarker(firstBytes, EBML_MAGIC) && headerBytes !== null) {
      const stableHeaderArrayBuffer = new ArrayBuffer(headerBytes.byteLength);
      new Uint8Array(stableHeaderArrayBuffer).set(headerBytes);
      blob = new Blob([stableHeaderArrayBuffer, blob], { type: mimeType || 'audio/webm' });
      headerPrependedResult = true;
    }

    return { blob, headerPrepended: headerPrependedResult };
  };

  const collectOverlapChunks = (
    previousSegmentChunks: Array<{ blob: Blob; startOffsetMs: number; endOffsetMs: number }>,
  ): Array<{ blob: Blob; startOffsetMs: number; endOffsetMs: number }> => {
    const overlapChunks: Array<{ blob: Blob; startOffsetMs: number; endOffsetMs: number }> = [];
    const overlapStartMs = Math.max(
      0,
      previousSegmentChunks[previousSegmentChunks.length - 1].endOffsetMs - SEGMENT_TRANSCRIPT_OVERLAP_MS,
    );

    for (let idx = previousSegmentChunks.length - 1; idx >= 0; idx -= 1) {
      const chunk = previousSegmentChunks[idx];
      overlapChunks.unshift(chunk);
      if (chunk.startOffsetMs <= overlapStartMs) {
        break;
      }
    }

    return overlapChunks;
  };

  state.totalChunksToTranscribe = totalSegments;
  state.transcribedChunks = 0;

  // Measure actual audio duration of each segment blob (without overlap) for accurate timing
  let cumulativeOffsetMs = 0;
  const measuredTimings: Array<{ startOffsetMs: number; endOffsetMs: number }> = [];

  for (const segment of segmentBlobs) {
    const measuredMs = await getAudioDurationMs(segment.blob);
    if (measuredMs !== null) {
      measuredTimings.push({ startOffsetMs: cumulativeOffsetMs, endOffsetMs: cumulativeOffsetMs + measuredMs });
      cumulativeOffsetMs += measuredMs;
    } else {
      // Fallback to wall-clock based timing from chunk createdAt
      measuredTimings.push({ startOffsetMs: segment.startOffsetMs, endOffsetMs: segment.endOffsetMs });
      cumulativeOffsetMs = segment.endOffsetMs;
    }
  }

  for (const [index, segment] of segmentBlobs.entries()) {
    const segNumber = index + 1;
    let transcribeBlob = segment.blob;
    let headerPrependedForUpload = segment.headerPrepended;
    let overlapAppliedMs = 0;

    if (index > 0) {
      const previousSegment = segmentBlobs[index - 1];
      const overlapChunks = collectOverlapChunks(previousSegment.chunks);

      if (overlapChunks.length > 0) {
        const withOverlap = await buildSegmentBlobFromChunks([...overlapChunks, ...segment.chunks], segNumber);
        if (withOverlap.blob.size <= HARD_MAX_SEGMENT_BYTES) {
          transcribeBlob = withOverlap.blob;
          headerPrependedForUpload = withOverlap.headerPrepended;
          overlapAppliedMs = Math.max(0, previousSegment.endOffsetMs - overlapChunks[0].startOffsetMs);
        } else {
          console.info(
            `[segmentation] overlap skipped seg=${segNumber} reason=hard-max overlapSize=${withOverlap.blob.size} hardMaxBytes=${HARD_MAX_SEGMENT_BYTES}`,
          );
        }
      }
    }

    const segFirst64Bytes = new Uint8Array(await transcribeBlob.slice(0, 64).arrayBuffer());
    const segFirst4Hex = bytesToHex(segFirst64Bytes.slice(0, 4));
    const segFirst64Hex = bytesToHex(segFirst64Bytes);

    const segHexLog =
      segNumber === 1
        ? `segFirst4Hex=${segFirst4Hex} segFirst64Hex=${segFirst64Hex}`
        : `segFirst4Hex=${segFirst4Hex}`;

    const timing = measuredTimings[index];
    console.info(
      `[segmentation] upload seg=${segNumber}/${totalSegments} size=${transcribeBlob.size} type=${transcribeBlob.type || '(empty)'} headerPrepended=${headerPrependedForUpload} overlapMs=${overlapAppliedMs} headerLen=${extractedHeaderLen} markerIndex=${headerMarkerIndex} scanLen=${headerScanLen} timing=${timing.startOffsetMs}-${timing.endOffsetMs}ms ${segHexLog}`,
    );
    await transcribeSegmentBlob(transcribeBlob, segNumber, totalSegments, {
      startOffsetMs: timing.startOffsetMs,
      endOffsetMs: timing.endOffsetMs,
    });

    state.transcribedChunks = segNumber;
    updateStatus(state.status, state.detail);
  }
}
