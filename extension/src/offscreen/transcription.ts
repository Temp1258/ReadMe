import { appendSessionSegment } from '../db/indexeddb';
import { transcribeAudioBlob, WhisperApiError } from '../stt/whisper';
import { state, inMemoryApiKey, updateStatus, broadcast } from './state';
import {
  CHUNK_MIN_BYTES,
  MIN_OVERLAP_DEDUP_WORDS,
  MAX_OVERLAP_DEDUP_WORDS,
  TRANSCRIBE_MAX_RETRIES,
  TRANSCRIBE_INITIAL_BACKOFF_MS,
  MAX_SEGMENT_BYTES,
} from './constants';

function getChunkFilename(seq: number, mimeType: string): string {
  const normalizedMimeType = mimeType.toLowerCase();

  if (normalizedMimeType.includes('webm')) {
    return `chunk-${seq}.webm`;
  }

  if (normalizedMimeType.includes('wav')) {
    return `chunk-${seq}.wav`;
  }

  if (normalizedMimeType.includes('mp4') || normalizedMimeType.includes('m4a')) {
    return `chunk-${seq}.m4a`;
  }

  return `chunk-${seq}.webm`;
}

export async function appendTranscript(
  seq: number,
  text: string,
  timing?: { startOffsetMs?: number; endOffsetMs?: number },
): Promise<void> {
  const normalizedIncoming = text.trim();
  if (!normalizedIncoming) {
    return;
  }

  const normalizeWord = (word: string): string => word.toLowerCase().replace(/(^[^a-z0-9']+|[^a-z0-9']+$)/gi, '');

  const removeOverlapPrefix = (existingTranscript: string, incomingText: string): string => {
    const existingWords = existingTranscript.trim().split(/\s+/).filter(Boolean);
    const incomingWords = incomingText.trim().split(/\s+/).filter(Boolean);

    if (existingWords.length === 0 || incomingWords.length === 0) {
      return incomingText.trim();
    }

    const existingTailWords = existingWords
      .slice(-MAX_OVERLAP_DEDUP_WORDS)
      .map((word) => normalizeWord(word))
      .filter(Boolean);
    const incomingNormalizedWords = incomingWords.map((word) => normalizeWord(word)).filter(Boolean);

    const maxOverlap = Math.min(existingTailWords.length, incomingNormalizedWords.length, MAX_OVERLAP_DEDUP_WORDS);

    for (let overlapSize = maxOverlap; overlapSize >= MIN_OVERLAP_DEDUP_WORDS; overlapSize -= 1) {
      const existingSuffix = existingTailWords.slice(-overlapSize);
      const incomingPrefix = incomingNormalizedWords.slice(0, overlapSize);
      const isMatch = existingSuffix.every((word, idx) => word === incomingPrefix[idx]);

      if (isMatch) {
        const dedupedWords = incomingWords.slice(overlapSize).join(' ').trim();
        return dedupedWords;
      }
    }

    return incomingText.trim();
  };

  const normalized = removeOverlapPrefix(state.transcript, normalizedIncoming);
  if (!normalized) {
    return;
  }

  if (state.activeSessionId) {
    const persisted = await appendSessionSegment(state.activeSessionId, normalized, timing);
    state.transcript = persisted?.transcript ?? (state.transcript ? `${state.transcript}\n${normalized}` : normalized);
  } else {
    state.transcript = state.transcript ? `${state.transcript}\n${normalized}` : normalized;
  }

  broadcast({
    type: 'TRANSCRIPT_UPDATE',
    payload: {
      seq,
      text: normalized,
      transcript: state.transcript,
    },
  });
}

function buildSegmentErrorMessage(segmentIndex: number, segmentBytes: number, error: WhisperApiError): string {
  if (error.status === 413) {
    return `Segment ${segmentIndex} failed with status 413. Segment size ${segmentBytes} bytes exceeded the safe upload threshold (<20MB) of ${MAX_SEGMENT_BYTES} bytes.`;
  }

  return `Segment ${segmentIndex} failed with status ${error.status}.`;
}

export async function transcribeSegmentBlob(
  segmentBlob: Blob,
  segmentIndex: number,
  totalSegments: number,
  timing?: { startOffsetMs?: number; endOffsetMs?: number },
): Promise<void> {
  const apiKey = inMemoryApiKey;

  if (segmentBlob.size === 0 || segmentBlob.size < CHUNK_MIN_BYTES) {
    return;
  }

  const segmentMB = segmentBlob.size / (1024 * 1024);
  updateStatus('Transcribing', `Transcribing segment ${segmentIndex}/${totalSegments} (${segmentMB.toFixed(2)}MB)...`);
  console.info(`[transcribe-segment] seg=${segmentIndex} size=${segmentBlob.size} type=${segmentBlob.type || '(empty)'}`);

  if (state.useMockTranscription) {
    await appendTranscript(segmentIndex, `[mock] segment ${segmentIndex} text`, timing);
    return;
  }

  if (!apiKey) {
    throw new Error('Missing OpenAI API key for REAL transcription mode.');
  }

  const filename = getChunkFilename(segmentIndex, segmentBlob.type || '');

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_RETRIES; attempt += 1) {
    try {
      const text = await transcribeAudioBlob(segmentBlob, {
        apiKey,
        model: 'whisper-1',
        fileName: filename,
        maxRetries: 1,
      });
      await appendTranscript(segmentIndex, text || `[empty] segment ${segmentIndex}`, timing);
      return;
    } catch (error) {
      const isFormatError =
        error instanceof WhisperApiError &&
        error.status === 400 &&
        ['invalid file format', 'unsupported', 'could not decode'].some((needle) =>
          error.apiMessage.toLowerCase().includes(needle),
        );

      if (isFormatError) {
        console.info(`format-error fallback retrying seg ${segmentIndex}`);

        try {
          const retryBlob = segmentBlob.type ? segmentBlob : new Blob([segmentBlob], { type: 'audio/webm' });
          const retryText = await transcribeAudioBlob(retryBlob, {
            apiKey,
            model: 'whisper-1',
            fileName: filename,
            maxRetries: 1,
          });
          console.info(`fallback success seg ${segmentIndex}`);
          await appendTranscript(segmentIndex, retryText || `[empty] segment ${segmentIndex}`, timing);
          return;
        } catch {
          await appendTranscript(segmentIndex, `[skipped] segment ${segmentIndex} invalid file format`, timing);
          return;
        }
      }

      if (error instanceof WhisperApiError && error.status !== 429 && error.status < 500) {
        throw new Error(buildSegmentErrorMessage(segmentIndex, segmentBlob.size, error));
      }

      if (attempt >= TRANSCRIBE_MAX_RETRIES) {
        throw new Error(`Segment ${segmentIndex} failed after ${TRANSCRIBE_MAX_RETRIES} attempts.`);
      }

      const backoffMs = TRANSCRIBE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
