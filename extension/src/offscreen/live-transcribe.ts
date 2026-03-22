import { state, inMemoryApiKey, inMemoryDeepgramApiKey, inMemorySiliconflowApiKey, activeProvider, broadcast, updateStatus, liveCumulativeAudioOffsetMs, advanceLiveCumulativeAudioOffset } from './state';
import { appendSessionSegment } from '../db/indexeddb';
import { transcribeAudioBlob } from '../stt/whisper';
import { transcribeWithDeepgram } from '../stt/deepgram';
import { CHUNK_MIN_BYTES, LIVE_TRANSCRIBE_CHUNK_COUNT } from './constants';
import { extractWebmHeaderFromBlob } from '../utils/webm';
import { removeOverlapPrefix } from '../utils/dedup';
import { getAudioDurationMs } from '../utils/audio-duration';

async function extractWebmHeader(firstBlob: Blob): Promise<void> {
  if (state.webmHeaderExtracted) return;
  state.webmHeaderExtracted = true;

  const header = await extractWebmHeaderFromBlob(firstBlob);
  if (!header) {
    console.info('[live-transcribe] no WebM header found in first chunk');
    return;
  }

  state.webmHeader = header;
  console.info(`[live-transcribe] WebM header extracted: ${state.webmHeader.byteLength} bytes`);
}

function buildTranscribableBlob(chunks: Array<{ blob: Blob }>): Blob {
  const parts: BlobPart[] = [];

  if (state.webmHeader) {
    const headerCopy = new ArrayBuffer(state.webmHeader.byteLength);
    new Uint8Array(headerCopy).set(state.webmHeader);
    parts.push(new Blob([headerCopy]));
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
    void processLiveTranscribeQueue();
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
  }
}

export async function flushLiveTranscribeQueue(): Promise<void> {
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

async function transcribeBatch(
  chunks: Array<{ blob: Blob; seq: number; createdAt: number }>,
): Promise<void> {
  const apiKey = inMemoryApiKey;
  const deepgramKey = inMemoryDeepgramApiKey;
  const siliconflowKey = inMemorySiliconflowApiKey;
  if (!apiKey && !deepgramKey && !siliconflowKey) return;

  const mergedBlob = buildTranscribableBlob(chunks);
  if (mergedBlob.size < CHUNK_MIN_BYTES) return;

  const startSeq = chunks[0].seq;
  const endSeq = chunks[chunks.length - 1].seq;
  const sizeMB = (mergedBlob.size / (1024 * 1024)).toFixed(2);
  console.info(`[live-transcribe] transcribing chunks ${startSeq}-${endSeq} (${sizeMB}MB) provider=${activeProvider}`);

  try {
    let text: string;
    if (activeProvider === 'deepgram' && deepgramKey) {
      text = await transcribeWithDeepgram(mergedBlob, { apiKey: deepgramKey });
    } else if (activeProvider === 'siliconflow' && siliconflowKey) {
      text = await transcribeAudioBlob(mergedBlob, {
        apiKey: siliconflowKey,
        model: 'FunAudioLLM/SenseVoiceSmall',
        endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
        fileName: `live-${startSeq}-${endSeq}.webm`,
        maxRetries: 2,
      });
    } else if (apiKey) {
      text = await transcribeAudioBlob(mergedBlob, {
        apiKey,
        model: 'whisper-1',
        fileName: `live-${startSeq}-${endSeq}.webm`,
        maxRetries: 2,
      });
    } else {
      return;
    }

    const trimmed = text?.trim();
    if (!trimmed) {
      // Advance cumulative offset even for empty results so timing stays accurate
      const emptyDurationMs = await getAudioDurationMs(mergedBlob);
      if (emptyDurationMs !== null) {
        advanceLiveCumulativeAudioOffset(emptyDurationMs);
      }
      state.transcribedChunks = endSeq;
      updateStatus(state.status, state.detail);
      return;
    }

    const deduped = removeOverlapPrefix(state.transcript, trimmed);
    if (!deduped) {
      // Even when deduped to empty, advance cumulative offset so next segment starts correctly
      const skipDurationMs = await getAudioDurationMs(mergedBlob);
      if (skipDurationMs !== null) {
        advanceLiveCumulativeAudioOffset(skipDurationMs);
      }
      state.transcribedChunks = endSeq;
      updateStatus(state.status, state.detail);
      return;
    }

    const measuredDurationMs = await getAudioDurationMs(mergedBlob);
    const startOffsetMs = liveCumulativeAudioOffsetMs;
    let endOffsetMs: number;
    if (measuredDurationMs !== null) {
      endOffsetMs = startOffsetMs + measuredDurationMs;
    } else {
      // Fallback: estimate from wall-clock timestamps
      const recordingSession = state.recordingSession;
      endOffsetMs = recordingSession
        ? Math.max(startOffsetMs, chunks[chunks.length - 1].createdAt - recordingSession.startTime)
        : startOffsetMs;
    }
    advanceLiveCumulativeAudioOffset(measuredDurationMs ?? (endOffsetMs - startOffsetMs));

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

    console.info(`[live-transcribe] success chunks ${startSeq}-${endSeq}: "${deduped.slice(0, 80)}..."`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[live-transcribe] failed chunks ${startSeq}-${endSeq}: ${msg}`);
  }
}
