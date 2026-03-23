import { state, inMemoryApiKey, inMemoryDeepgramApiKey, inMemorySiliconflowApiKey, activeProvider, broadcast, updateStatus, liveCumulativeAudioOffsetMs, advanceLiveCumulativeAudioOffset } from './state';
import { appendSessionSegment, insertSessionSegmentByTime } from '../db/indexeddb';
import { transcribeAudioBlob } from '../stt/whisper';
import { transcribeWithDeepgram } from '../stt/deepgram';
import { CHUNK_MIN_BYTES, LIVE_TRANSCRIBE_CHUNK_COUNT, TRANSCRIBE_MAX_RETRIES, TRANSCRIBE_INITIAL_BACKOFF_MS } from './constants';
import { extractWebmHeaderFromBlob } from '../utils/webm';
import { removeOverlapPrefix } from '../utils/dedup';
import { getAudioDurationMs } from '../utils/audio-duration';

/** Maximum number of failed batches to keep in memory for recovery. */
const MAX_FAILED_BATCHES = 20;

/**
 * Promise tracking the in-flight processLiveTranscribeQueue so that
 * flushLiveTranscribeQueue can await it before draining remaining chunks.
 */
let liveTranscribeProcessingPromise: Promise<void> | null = null;

/**
 * The last chunk blob from the previous transcription batch.
 * Prepended to the next batch to provide audio context overlap,
 * improving transcription accuracy at segment boundaries.
 */
let previousBatchLastChunk: Blob | null = null;

/**
 * Cached Blob of the WebM header bytes to avoid re-copying the
 * ArrayBuffer on every buildTranscribableBlob call (120+ times).
 */
let cachedWebmHeaderBlob: Blob | null = null;

async function extractWebmHeader(firstBlob: Blob): Promise<void> {
  if (state.webmHeaderExtracted) return;
  state.webmHeaderExtracted = true;

  const header = await extractWebmHeaderFromBlob(firstBlob);
  if (!header) {
    console.info('[live-transcribe] no WebM header found in first chunk');
    return;
  }

  state.webmHeader = header;
  // Pre-build the header blob once so we don't copy ArrayBuffer every batch
  const headerCopy = new ArrayBuffer(header.byteLength);
  new Uint8Array(headerCopy).set(header);
  cachedWebmHeaderBlob = new Blob([headerCopy]);
  console.info(`[live-transcribe] WebM header extracted: ${state.webmHeader.byteLength} bytes`);
}

function buildTranscribableBlob(chunks: Array<{ blob: Blob }>, overlapChunk?: Blob | null): Blob {
  const parts: BlobPart[] = [];

  if (cachedWebmHeaderBlob) {
    parts.push(cachedWebmHeaderBlob);
  }

  // Prepend the overlap chunk from the previous batch for context
  if (overlapChunk) {
    parts.push(overlapChunk);
  }

  for (const chunk of chunks) {
    parts.push(chunk.blob);
  }

  return new Blob(parts, { type: 'audio/webm' });
}

export function enqueueChunkForLiveTranscription(blob: Blob, seq: number, createdAt: number): void {
  if (!state.liveTranscribeEnabled || state.useMockTranscription) return;

  state.liveTranscribeQueue.push({ blob, seq, createdAt });
  state.totalChunksToTranscribe = seq;

  if (seq === 1) {
    void extractWebmHeader(blob);
  }

  if (state.liveTranscribeQueue.length >= LIVE_TRANSCRIBE_CHUNK_COUNT && !state.liveTranscribeRunning) {
    liveTranscribeProcessingPromise = processLiveTranscribeQueue();
    // Prevent unhandled rejection on fire-and-forget
    liveTranscribeProcessingPromise.catch(() => {});
  }
}

async function processLiveTranscribeQueue(): Promise<void> {
  if (state.liveTranscribeRunning) return;
  state.liveTranscribeRunning = true;

  try {
    while (state.liveTranscribeQueue.length >= LIVE_TRANSCRIBE_CHUNK_COUNT) {
      const batch = state.liveTranscribeQueue.splice(0, LIVE_TRANSCRIBE_CHUNK_COUNT);
      await transcribeBatch(batch);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[live-transcribe] batch failed: ${msg}`);
  } finally {
    state.liveTranscribeRunning = false;
    liveTranscribeProcessingPromise = null;
  }
}

export async function flushLiveTranscribeQueue(): Promise<void> {
  // Wait for any in-flight processLiveTranscribeQueue to complete first.
  // This prevents the race where processLiveTranscribeQueue already spliced
  // the queue (making it appear empty) but hasn't finished transcription yet.
  if (liveTranscribeProcessingPromise) {
    await liveTranscribeProcessingPromise;
    liveTranscribeProcessingPromise = null;
  }

  if (state.liveTranscribeQueue.length === 0) return;

  state.liveTranscribeRunning = true;
  try {
    const remaining = state.liveTranscribeQueue.splice(0);
    if (remaining.length > 0) {
      await transcribeBatch(remaining);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[live-transcribe] flush failed: ${msg}`);
  } finally {
    state.liveTranscribeRunning = false;
  }
}

export interface CapturedKeys {
  apiKey: string | null;
  deepgramKey: string | null;
  siliconflowKey: string | null;
  provider: typeof activeProvider;
}

function callTranscriptionApi(
  blob: Blob,
  startSeq: number,
  endSeq: number,
  keys: CapturedKeys,
): Promise<string> {
  if (keys.provider === 'deepgram' && keys.deepgramKey) {
    return transcribeWithDeepgram(blob, { apiKey: keys.deepgramKey });
  }

  if (keys.provider === 'siliconflow' && keys.siliconflowKey) {
    return transcribeAudioBlob(blob, {
      apiKey: keys.siliconflowKey,
      model: 'FunAudioLLM/SenseVoiceSmall',
      endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      fileName: `live-${startSeq}-${endSeq}.webm`,
      maxRetries: 1,
    });
  }

  if (keys.apiKey) {
    return transcribeAudioBlob(blob, {
      apiKey: keys.apiKey,
      model: 'whisper-1',
      fileName: `live-${startSeq}-${endSeq}.webm`,
      maxRetries: 1,
    });
  }

  return Promise.reject(new Error('No API key available'));
}

async function transcribeBatch(
  chunks: Array<{ blob: Blob; seq: number; createdAt: number }>,
): Promise<void> {
  // Capture keys immediately (synchronously) so they remain valid even
  // if stopRecording clears the module-level variables later.
  const keys: CapturedKeys = {
    apiKey: inMemoryApiKey,
    deepgramKey: inMemoryDeepgramApiKey,
    siliconflowKey: inMemorySiliconflowApiKey,
    provider: activeProvider,
  };
  if (!keys.apiKey && !keys.deepgramKey && !keys.siliconflowKey) return;

  // Build blob with overlap from previous batch for context accuracy
  const overlapChunk = previousBatchLastChunk;
  const mergedBlob = buildTranscribableBlob(chunks, overlapChunk);
  if (mergedBlob.size < CHUNK_MIN_BYTES) return;

  // Save the last chunk of this batch as overlap for the next batch
  previousBatchLastChunk = chunks[chunks.length - 1].blob;

  const startSeq = chunks[0].seq;
  const endSeq = chunks[chunks.length - 1].seq;
  const sizeMB = (mergedBlob.size / (1024 * 1024)).toFixed(2);
  const hasOverlap = overlapChunk !== null;
  console.info(`[live-transcribe] transcribing chunks ${startSeq}-${endSeq} (${sizeMB}MB) provider=${keys.provider} overlap=${hasOverlap}`);

  // Measure duration of the ACTUAL new chunks only (without overlap) for accurate timing.
  // Build a blob without the overlap chunk to avoid counting overlap duration.
  const newChunksBlob = overlapChunk ? buildTranscribableBlob(chunks) : mergedBlob;
  const measuredDurationMs = await getAudioDurationMs(newChunksBlob);
  const startOffsetMs = liveCumulativeAudioOffsetMs;
  let endOffsetMs: number;
  if (measuredDurationMs !== null) {
    endOffsetMs = startOffsetMs + measuredDurationMs;
  } else {
    const recordingSession = state.recordingSession;
    endOffsetMs = recordingSession
      ? Math.max(startOffsetMs, chunks[chunks.length - 1].createdAt - recordingSession.startTime)
      : startOffsetMs;
  }

  // Always advance the offset immediately so subsequent batches get correct timing
  advanceLiveCumulativeAudioOffset(measuredDurationMs ?? (endOffsetMs - startOffsetMs));

  // Retry loop with exponential backoff
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_RETRIES; attempt += 1) {
    try {
      const text = await callTranscriptionApi(mergedBlob, startSeq, endSeq, keys);

      const trimmed = text?.trim();
      if (!trimmed) {
        state.transcribedChunks = endSeq;
        updateStatus(state.status, state.detail);
        return;
      }

      const deduped = removeOverlapPrefix(state.transcript, trimmed);
      if (!deduped) {
        state.transcribedChunks = endSeq;
        updateStatus(state.status, state.detail);
        return;
      }

      if (state.activeSessionId) {
        const persisted = await appendSessionSegment(state.activeSessionId, deduped, {
          startOffsetMs,
          endOffsetMs,
        });
        state.transcript = persisted?.transcript ?? (state.transcript ? `${state.transcript}\n${deduped}` : deduped);
      } else {
        state.transcript = state.transcript ? `${state.transcript}\n${deduped}` : deduped;
      }

      broadcast({
        type: 'TRANSCRIPT_UPDATE',
        payload: {
          seq: endSeq,
          text: deduped,
          transcript: state.transcript,
        },
      });

      state.transcribedChunks = endSeq;
      updateStatus(state.status, state.detail);

      console.info(`[live-transcribe] success chunks ${startSeq}-${endSeq} attempt=${attempt}: "${deduped.slice(0, 80)}..."`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < TRANSCRIBE_MAX_RETRIES) {
        const backoffMs = TRANSCRIBE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`[live-transcribe] attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES} failed chunks ${startSeq}-${endSeq}: ${lastError.message}, retrying in ${backoffMs}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  // All retries exhausted — save to failed queue for end-of-recording recovery.
  // Cap the queue to prevent unbounded memory growth during long recordings.
  console.warn(`[live-transcribe] all ${TRANSCRIBE_MAX_RETRIES} attempts failed chunks ${startSeq}-${endSeq}: ${lastError?.message}`);
  if (state.liveFailedBatches.length < MAX_FAILED_BATCHES) {
    state.liveFailedBatches.push({
      mergedBlob,
      startSeq,
      endSeq,
      startOffsetMs,
      endOffsetMs,
    });
    console.info(`[live-transcribe] queued failed batch for recovery (${state.liveFailedBatches.length}/${MAX_FAILED_BATCHES})`);
  } else {
    console.warn(`[live-transcribe] failed batch queue full (${MAX_FAILED_BATCHES}), dropping chunks ${startSeq}-${endSeq}`);
  }

  state.transcribedChunks = endSeq;
  updateStatus(state.status, state.detail);
}

export async function retryFailedBatches(keys: CapturedKeys): Promise<void> {
  const failedBatches = state.liveFailedBatches.splice(0);
  if (failedBatches.length === 0) return;

  console.info(`[live-transcribe] retrying ${failedBatches.length} failed batch(es)`);

  for (const batch of failedBatches) {
    let recovered = false;

    for (let attempt = 1; attempt <= TRANSCRIBE_MAX_RETRIES; attempt += 1) {
      try {
        const text = await callTranscriptionApi(batch.mergedBlob, batch.startSeq, batch.endSeq, keys);
        const trimmed = text?.trim();
        if (!trimmed) {
          console.info(`[live-transcribe] recovery chunks ${batch.startSeq}-${batch.endSeq}: empty result, skipping`);
          recovered = true;
          break;
        }

        if (state.activeSessionId) {
          const persisted = await insertSessionSegmentByTime(state.activeSessionId, trimmed, {
            startOffsetMs: batch.startOffsetMs,
            endOffsetMs: batch.endOffsetMs,
          });
          if (persisted) {
            state.transcript = persisted.transcript;
          }
        } else {
          state.transcript = state.transcript ? `${state.transcript}\n${trimmed}` : trimmed;
        }

        broadcast({
          type: 'TRANSCRIPT_UPDATE',
          payload: {
            seq: batch.endSeq,
            text: trimmed,
            transcript: state.transcript,
          },
        });

        console.info(`[live-transcribe] recovery success chunks ${batch.startSeq}-${batch.endSeq} attempt=${attempt}: "${trimmed.slice(0, 80)}..."`);
        recovered = true;
        break;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < TRANSCRIBE_MAX_RETRIES) {
          const backoffMs = TRANSCRIBE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
          console.warn(`[live-transcribe] recovery attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES} failed chunks ${batch.startSeq}-${batch.endSeq}: ${msg}, retrying in ${backoffMs}ms`);
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        } else {
          console.error(`[live-transcribe] recovery failed chunks ${batch.startSeq}-${batch.endSeq} after ${TRANSCRIBE_MAX_RETRIES} attempts: ${msg}`);
        }
      }
    }

    if (!recovered) {
      if (state.activeSessionId) {
        await insertSessionSegmentByTime(state.activeSessionId, `[skipped] chunks ${batch.startSeq}-${batch.endSeq}`, {
          startOffsetMs: batch.startOffsetMs,
          endOffsetMs: batch.endOffsetMs,
        });
      }
    }
  }
}

export function resetLiveTranscribeState(): void {
  previousBatchLastChunk = null;
  liveTranscribeProcessingPromise = null;
  cachedWebmHeaderBlob = null;
}
