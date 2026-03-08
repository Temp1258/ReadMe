import {
  appendRecordingChunk,
  appendSessionSegment,
  createRecordingSession,
  createSession,
  type RecordingSessionRecord,
  streamRecordingChunksBySession,
  updateRecordingSession,
  updateSessionState,
} from './db/indexeddb';
import { transcribeAudioBlob, WhisperApiError } from './stt/whisper';

export {};

type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Stopped' | 'Error';
type PersistedStatus = 'idle' | 'listening' | 'transcribing' | 'stopped' | 'error';
type AudioSource = 'mic' | 'tab' | 'mix';

type RuntimeMessage =
  | { type: 'GET_AUDIO_STATE' }
  | {
      type: 'START_RECORDING';
      payload?: { deviceId?: string; source?: AudioSource; streamId?: string };
    }
  | { type: 'STOP_RECORDING' }
  | { type: 'REFRESH_SETTINGS' };

type RecordingDiagnostics = {
  durationSec: number;
  durationLabel: string;
  totalBytes: number;
  totalMB: number;
  mbPerMin: number;
  estMinTo25MB: number | null;
};

type RuntimeEventMessage =
  | {
      type: 'STATUS_UPDATE';
      payload: {
        status: AudioStatus;
        detail?: string;
        selectedDeviceId: string;
        selectedSource: AudioSource;
        seq: number;
        diagnostics: RecordingDiagnostics;
      };
    }
  | { type: 'TRANSCRIPT_UPDATE'; payload: { seq: number; text: string; transcript: string } }
  | { type: 'ERROR'; payload: { message: string } };


type GetSttSettingsResponse =
  | {
      ok: true;
      provider: 'openai' | 'mock';
      keyPresent: boolean;
      apiKey?: string;
    }
  | { ok: false; error: string };

const CHUNK_TIMESLICE_MS = 30_000;
const CHUNK_MIN_BYTES = 1_024;
const MAX_SEGMENT_BYTES = 19 * 1024 * 1024;
const TRANSCRIBE_MAX_RETRIES = 3;
const TRANSCRIBE_INITIAL_BACKOFF_MS = 500;

let inMemoryApiKey: string | null = null;

const state = {
  status: 'Idle' as AudioStatus,
  detail: 'Idle',
  selectedDeviceId: 'default',
  selectedSource: 'mic' as AudioSource,
  seq: 0,
  activeStream: null as MediaStream | null,
  activeInputStream: null as MediaStream | null,
  recorder: null as MediaRecorder | null,
  playbackContext: null as AudioContext | null,
  playbackSourceNode: null as MediaStreamAudioSourceNode | null,
  playbackDestinationNode: null as MediaStreamAudioDestinationNode | null,
  transcript: '',
  activeSessionId: null as string | null,
  useMockTranscription: false,
  recordingSession: null as RecordingSessionRecord | null,
  nextChunkSeq: 1,
  diagnosticsTimerId: null as number | null,
};

async function refreshSttRuntimeSettings(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: 'GET_STT_SETTINGS' })) as GetSttSettingsResponse;

  if (!response?.ok) {
    const message = response?.error ?? 'Unable to fetch STT settings';
    inMemoryApiKey = null;
    state.useMockTranscription = true;
    console.info(`STT: settings unavailable error=${message}`);
    return;
  }

  const providerId = response.provider;
  const apiKey = response.apiKey ?? '';
  const keyPresent = apiKey.trim().length > 0;
  const shouldUseRealTranscription = response.provider === 'openai' && response.keyPresent === true && keyPresent;

  inMemoryApiKey = shouldUseRealTranscription ? apiKey : null;
  state.useMockTranscription = !shouldUseRealTranscription;

  console.info(
    `STT: providerId=${providerId} responseProvider=${response.provider} responseKeyPresent=${response.keyPresent} canonicalKeyPresent=${keyPresent}`,
  );

  if (providerId === 'openai' && !response.keyPresent) {
    console.info('STT: OpenAI selected but API key is empty; using MOCK mode');
  }

  console.info(state.useMockTranscription ? 'STT: using MOCK mode' : 'STT: using REAL mode');
}

function toPersistedStatus(status: AudioStatus): PersistedStatus {
  if (status === 'Listening') {
    return 'listening';
  }

  if (status === 'Transcribing') {
    return 'transcribing';
  }

  if (status === 'Error') {
    return 'error';
  }

  if (status === 'Stopped') {
    return 'stopped';
  }

  return 'idle';
}


function formatDurationLabel(durationSec: number): string {
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function computeDiagnostics(): RecordingDiagnostics {
  const recordingSession = state.recordingSession;
  if (!recordingSession) {
    return {
      durationSec: 0,
      durationLabel: '00:00',
      totalBytes: 0,
      totalMB: 0,
      mbPerMin: 0,
      estMinTo25MB: null,
    };
  }

  const endTime = recordingSession.stopTime ?? Date.now();
  const durationSec = Math.max(0, Math.floor((endTime - recordingSession.startTime) / 1000));
  const totalMB = recordingSession.totalBytes / (1024 * 1024);
  const mbPerMin = durationSec > 0 ? (totalMB / durationSec) * 60 : 0;
  const remainingMB = Math.max(0, 25 - totalMB);

  return {
    durationSec,
    durationLabel: formatDurationLabel(durationSec),
    totalBytes: recordingSession.totalBytes,
    totalMB,
    mbPerMin,
    estMinTo25MB: mbPerMin > 0 ? remainingMB / mbPerMin : null,
  };
}

function startDiagnosticsTimer(): void {
  if (state.diagnosticsTimerId !== null) {
    clearInterval(state.diagnosticsTimerId);
  }

  state.diagnosticsTimerId = window.setInterval(() => {
    if (state.status === 'Listening') {
      updateStatus(state.status, state.detail);
    }
  }, 1000);
}

function stopDiagnosticsTimer(): void {
  if (state.diagnosticsTimerId !== null) {
    clearInterval(state.diagnosticsTimerId);
    state.diagnosticsTimerId = null;
  }
}

async function setRecordingSessionError(sessionId: string): Promise<void> {
  try {
    const updated = await updateRecordingSession(sessionId, {
      status: 'error',
      stopTime: Date.now(),
    });
    if (updated) {
      state.recordingSession = updated;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to set session error status sessionId=${sessionId} error=${message}`);
  }
}

async function persistChunk(blob: Blob): Promise<void> {
  const recordingSession = state.recordingSession;
  if (!recordingSession) {
    return;
  }

  const chunkSeq = state.nextChunkSeq;

  try {
    await appendRecordingChunk({
      id: `${recordingSession.sessionId}:${chunkSeq}`,
      sessionId: recordingSession.sessionId,
      seq: chunkSeq,
      createdAt: Date.now(),
      bytes: blob.size,
      mimeType: blob.type || recordingSession.mimeType || 'audio/webm',
      blob,
    });

    const updated = await updateRecordingSession(recordingSession.sessionId, {
      totalBytes: recordingSession.totalBytes + blob.size,
      chunkCount: recordingSession.chunkCount + 1,
    });

    if (updated) {
      state.recordingSession = updated;
    }

    state.nextChunkSeq += 1;
    state.seq = chunkSeq;
    updateStatus(state.status, state.detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to persist chunk sessionId=${recordingSession.sessionId} seq=${chunkSeq} error=${message}`);
    await setRecordingSessionError(recordingSession.sessionId);
    publishError('Failed to persist recording chunk to IndexedDB.');
  }
}

function broadcast(message: RuntimeEventMessage): void {
  if (!chrome.runtime?.id) {
    return;
  }

  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open.
  });
}

function updateStatus(status: AudioStatus, detail?: string): void {
  state.status = status;
  state.detail = detail ?? status;

  const activeSessionId = state.activeSessionId;
  if (activeSessionId) {
    void updateSessionState(activeSessionId, {
      status: toPersistedStatus(status),
    });
  }

  broadcast({
    type: 'STATUS_UPDATE',
    payload: {
      status: state.status,
      detail: state.detail,
      selectedDeviceId: state.selectedDeviceId,
      selectedSource: state.selectedSource,
      seq: state.seq,
      diagnostics: computeDiagnostics(),
    },
  });
}

function publishError(message: string): void {
  updateStatus('Error', message);
  broadcast({ type: 'ERROR', payload: { message } });
}

async function stopTracks(): Promise<void> {
  if (state.activeInputStream) {
    state.activeInputStream.getTracks().forEach((track) => track.stop());
    state.activeInputStream = null;
  }

  if (state.activeStream) {
    state.activeStream.getTracks().forEach((track) => track.stop());
  }

  state.playbackSourceNode?.disconnect();
  state.playbackDestinationNode?.disconnect();
  state.playbackSourceNode = null;
  state.playbackDestinationNode = null;

  if (state.playbackContext) {
    await state.playbackContext.close();
    state.playbackContext = null;
  }

  state.activeStream = null;
}

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

function chooseRecorderMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return undefined;
}

async function appendTranscript(
  seq: number,
  text: string,
  timing?: { startOffsetMs?: number; endOffsetMs?: number },
): Promise<void> {
  const normalized = text.trim();
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

async function transcribeSegmentBlob(
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

async function transcribeRecordingInSegments(recordingSession: RecordingSessionRecord, mimeType: string): Promise<void> {
  let totalSegments = 0;
  let currentSegmentBlobs: Blob[] = [];
  let currentSegmentBytes = 0;
  const segmentBlobs: Array<{
    blob: Blob;
    headerPrepended: boolean;
    startOffsetMs: number;
    endOffsetMs: number;
  }> = [];
  let headerBytes: Uint8Array | null = null;
  let headerExtractionLogged = false;
  let seg2NoHeaderLogged = false;
  let firstChunkSeen = false;
  let headerMarkerIndex = -1;
  let headerScanLen = 0;
  let extractedHeaderLen = 0;
  let currentSegmentStartSeq: number | null = null;
  let currentSegmentEndSeq: number | null = null;

  const CLUSTER_MARKER = [0x1f, 0x43, 0xb6, 0x75] as const;
  const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
  const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;

  const findMarkerIndex = (buf: Uint8Array, marker: readonly number[]): number => {
    for (let idx = 0; idx <= buf.length - marker.length; idx += 1) {
      if (
        buf[idx] === marker[0] &&
        buf[idx + 1] === marker[1] &&
        buf[idx + 2] === marker[2] &&
        buf[idx + 3] === marker[3]
      ) {
        return idx;
      }
    }

    return -1;
  };

  const bytesToHex = (buf: Uint8Array): string => Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');

  const startsWithMarker = (buf: Uint8Array, marker: readonly number[]): boolean => {
    if (buf.length < marker.length) {
      return false;
    }

    for (let idx = 0; idx < marker.length; idx += 1) {
      if (buf[idx] !== marker[idx]) {
        return false;
      }
    }

    return true;
  };

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

  const flushSegment = async (): Promise<void> => {
    if (currentSegmentBlobs.length === 0 || currentSegmentBytes === 0) {
      return;
    }

    if (currentSegmentStartSeq === null || currentSegmentEndSeq === null) {
      throw new Error('Segment boundary metadata is missing chunk sequence numbers.');
    }

    const segIndex = segmentBlobs.length + 1;
    const firstChunkFirst4 = new Uint8Array(await currentSegmentBlobs[0].slice(0, 4).arrayBuffer());
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
    for (const blobPart of currentSegmentBlobs) {
      segmentParts.push(blobPart);
    }

    let segmentBlob = new Blob(segmentParts, { type: mimeType || 'audio/webm' });
    const segmentBytes = new Uint8Array(await segmentBlob.slice(0, 64).arrayBuffer());

    if (!startsWithMarker(segmentBytes, EBML_MAGIC) && headerBytes !== null) {
      const stableHeaderArrayBuffer = new ArrayBuffer(headerBytes.byteLength);
      new Uint8Array(stableHeaderArrayBuffer).set(headerBytes);
      segmentBlob = new Blob([stableHeaderArrayBuffer, segmentBlob], { type: mimeType || 'audio/webm' });
      headerPrepended = true;
    }

    if (segmentBlob.size > MAX_SEGMENT_BYTES) {
      throw new Error(
        `Segment ${segIndex} is ${segmentBlob.size} bytes, exceeding max segment size ${MAX_SEGMENT_BYTES} bytes.`,
      );
    }

    const startOffsetMs = Math.max(0, (currentSegmentStartSeq - 1) * recordingSession.timesliceMs);
    const endOffsetMs = Math.max(startOffsetMs, currentSegmentEndSeq * recordingSession.timesliceMs);

    segmentBlobs.push({ blob: segmentBlob, headerPrepended, startOffsetMs, endOffsetMs });
    currentSegmentBlobs = [];
    currentSegmentBytes = 0;
    currentSegmentStartSeq = null;
    currentSegmentEndSeq = null;
  };

  await streamRecordingChunksBySession(recordingSession.sessionId, async (chunk) => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      await tryExtractWebmHeaderBytes(chunk.blob);
    }

    const currentSegmentIndex = segmentBlobs.length + 1;
    const reservedHeaderBytes = currentSegmentIndex > 1 && headerBytes ? headerBytes.byteLength : 0;

    if (chunk.bytes + reservedHeaderBytes > MAX_SEGMENT_BYTES) {
      throw new Error(
        `Chunk ${chunk.seq} is ${chunk.bytes} bytes and cannot fit with required header reservation ${reservedHeaderBytes} bytes within max segment size ${MAX_SEGMENT_BYTES} bytes.`,
      );
    }

    if (currentSegmentBytes > 0 && currentSegmentBytes + reservedHeaderBytes + chunk.bytes > MAX_SEGMENT_BYTES) {
      await flushSegment();
    }

    const nextSegmentIndex = segmentBlobs.length + 1;
    const nextReservedHeaderBytes = nextSegmentIndex > 1 && headerBytes ? headerBytes.byteLength : 0;
    if (chunk.bytes + nextReservedHeaderBytes > MAX_SEGMENT_BYTES) {
      throw new Error(
        `Chunk ${chunk.seq} is ${chunk.bytes} bytes and cannot fit with required header reservation ${nextReservedHeaderBytes} bytes within max segment size ${MAX_SEGMENT_BYTES} bytes.`,
      );
    }

    currentSegmentBlobs.push(chunk.blob);
    currentSegmentBytes += chunk.bytes;
    if (currentSegmentStartSeq === null) {
      currentSegmentStartSeq = chunk.seq;
    }
    currentSegmentEndSeq = chunk.seq;
  });

  await flushSegment();
  totalSegments = segmentBlobs.length;

  for (const [index, segment] of segmentBlobs.entries()) {
    const segNumber = index + 1;
    const segFirst64Bytes = new Uint8Array(await segment.blob.slice(0, 64).arrayBuffer());
    const segFirst4Hex = bytesToHex(segFirst64Bytes.slice(0, 4));
    const segFirst64Hex = bytesToHex(segFirst64Bytes);

    const segHexLog =
      segNumber === 1
        ? `segFirst4Hex=${segFirst4Hex} segFirst64Hex=${segFirst64Hex}`
        : `segFirst4Hex=${segFirst4Hex}`;

    console.info(
      `[segmentation] upload seg=${segNumber}/${totalSegments} size=${segment.blob.size} type=${segment.blob.type || '(empty)'} headerPrepended=${segment.headerPrepended} headerLen=${extractedHeaderLen} markerIndex=${headerMarkerIndex} scanLen=${headerScanLen} ${segHexLog}`,
    );
    await transcribeSegmentBlob(segment.blob, segNumber, totalSegments, {
      startOffsetMs: segment.startOffsetMs,
      endOffsetMs: segment.endOffsetMs,
    });
  }
}

async function stopRecording(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = null;

  if (recorder && recorder.state !== 'inactive') {
    const stopDataPromise = new Promise<Blob | null>((resolve) => {
      recorder.addEventListener(
        'dataavailable',
        (event) => {
          resolve(event.data);
        },
        { once: true },
      );
    });

    recorder.requestData();
    const finalChunk = await stopDataPromise;
    if (finalChunk && finalChunk.size > 0) {
      await persistChunk(finalChunk);
    }
  }

  if (recorder && recorder.state !== 'inactive') {
    recorder.onerror = null;
    recorder.onstop = null;
    recorder.stop();
  }

  const recordingSession = state.recordingSession;

  let transcriptionFailed = false;

  if (recordingSession && recordingSession.chunkCount > 0) {
    updateStatus('Transcribing', 'Transcribing recording...');

    try {
      const recorderMimeType = recorder?.mimeType || recordingSession.mimeType || 'audio/webm';
      await transcribeRecordingInSegments(recordingSession, recorderMimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcriptionFailed = true;
      publishError(`Recording failed: ${message}`);
    }
  }

  await stopTracks();
  state.useMockTranscription = false;
  inMemoryApiKey = null;

  if (recordingSession) {
    try {
      const updated = await updateRecordingSession(recordingSession.sessionId, {
        stopTime: Date.now(),
        status: state.status === 'Error' ? 'error' : 'stopped',
      });
      if (updated) {
        state.recordingSession = updated;
      }

      const diagnostics = computeDiagnostics();
      const summarySession = state.recordingSession ?? recordingSession;
      console.info(
        `[recording-summary] sessionId=${summarySession.sessionId} durationSec=${diagnostics.durationSec} chunks=${summarySession.chunkCount} totalBytes=${summarySession.totalBytes} totalMB=${diagnostics.totalMB.toFixed(2)} mbPerMin=${diagnostics.mbPerMin.toFixed(2)} estMinTo25MB=${diagnostics.estMinTo25MB === null ? 'n/a' : diagnostics.estMinTo25MB.toFixed(1)} mime=${summarySession.mimeType || 'unknown'} timesliceMs=${summarySession.timesliceMs}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[recording-store] failed to finalize recording session sessionId=${recordingSession.sessionId} error=${message}`);
    }
  }

  if (state.activeSessionId) {
    void updateSessionState(state.activeSessionId, {
      endedAt: Date.now(),
      status: transcriptionFailed ? 'error' : 'stopped',
    });
    state.activeSessionId = null;
  }

  stopDiagnosticsTimer();
  state.recordingSession = null;
  state.nextChunkSeq = 1;

  if (!transcriptionFailed && state.status !== 'Error') {
    updateStatus('Stopped', 'Stopped');
  }
}

async function getTabAudioStream(streamId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          suppressLocalAudioPlayback: false,
        },
      } as MediaTrackConstraints,
      video: false,
    });
  } catch (err) {
    console.error('STT tab getUserMedia failed', err);
    throw err;
  }
}

async function getAudioStream(source: AudioSource, streamId?: string): Promise<MediaStream> {
  if (source === 'tab' || source === 'mix') {
    if (!streamId) {
      throw new Error('Missing tab capture stream id. Start from the popup Start button.');
    }

    const tabStream = await getTabAudioStream(streamId);
    state.activeInputStream = tabStream;

    const [tabTrack] = tabStream.getAudioTracks();
    console.info(
      `STT: tab stream acquired id=${tabStream.id} trackCount=${tabStream.getAudioTracks().length} trackEnabled=${tabTrack?.enabled ?? false} trackMuted=${tabTrack?.muted ?? true} trackReadyState=${tabTrack?.readyState ?? 'none'}`,
    );

    const context = new AudioContext();
    const tabSourceNode = context.createMediaStreamSource(tabStream);
    const destinationNode = context.createMediaStreamDestination();

    tabSourceNode.connect(destinationNode);
    tabSourceNode.connect(context.destination);

    let micStream: MediaStream | null = null;

    if (source === 'mix') {
      const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraint,
        video: false,
      });

      const [micTrack] = micStream.getAudioTracks();
      console.info(
        `STT: mic stream for mix acquired id=${micStream.id} trackCount=${micStream.getAudioTracks().length} trackEnabled=${micTrack?.enabled ?? false} trackMuted=${micTrack?.muted ?? true} trackReadyState=${micTrack?.readyState ?? 'none'}`,
      );

      const micSourceNode = context.createMediaStreamSource(micStream);
      micSourceNode.connect(destinationNode);
    }

    state.activeInputStream = new MediaStream([
      ...tabStream.getTracks(),
      ...(micStream ? micStream.getTracks() : []),
    ]);

    state.playbackContext = context;
    state.playbackSourceNode = tabSourceNode;
    state.playbackDestinationNode = destinationNode;

    const [recorderTrack] = destinationNode.stream.getAudioTracks();
    console.info(
      `STT: ${source} recording pipeline ready context=${context.state} recorderTrackCount=${destinationNode.stream.getAudioTracks().length} recorderTrackEnabled=${recorderTrack?.enabled ?? false} recorderTrackMuted=${recorderTrack?.muted ?? true}`,
    );

    return destinationNode.stream;
  }

  const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraint,
    video: false,
  });

  const [micTrack] = stream.getAudioTracks();
  console.info(
    `STT: mic stream acquired id=${stream.id} trackCount=${stream.getAudioTracks().length} trackEnabled=${micTrack?.enabled ?? false} trackMuted=${micTrack?.muted ?? true} trackReadyState=${micTrack?.readyState ?? 'none'}`,
  );

  return stream;
}

async function startRecording(deviceId?: string, source: AudioSource = 'mic', streamId?: string): Promise<void> {
  if (deviceId) {
    state.selectedDeviceId = deviceId;
  }

  state.selectedSource = source;

  await stopRecording();

  state.seq = 0;
  state.transcript = '';

  broadcast({
    type: 'TRANSCRIPT_UPDATE',
    payload: {
      seq: 0,
      text: '',
      transcript: '',
    },
  });

  const stream = await getAudioStream(state.selectedSource, streamId);
  await refreshSttRuntimeSettings();

  const sessionId = crypto.randomUUID();
  state.activeSessionId = sessionId;
  await createSession({
    id: sessionId,
    startedAt: Date.now(),
    source: state.selectedSource,
    deviceId: state.selectedDeviceId,
    status: 'listening',
  });

  state.activeStream = stream;

  const selectedMimeType = chooseRecorderMimeType();
  const recorder = selectedMimeType ? new MediaRecorder(stream, { mimeType: selectedMimeType }) : new MediaRecorder(stream);
  const recorderMimeType = recorder.mimeType || selectedMimeType || 'audio/webm';
  console.info(`STT: recorder mimeType=${recorder.mimeType || 'default'}`);

  state.recordingSession = {
    sessionId,
    startTime: Date.now(),
    status: 'recording',
    totalBytes: 0,
    chunkCount: 0,
    mimeType: recorderMimeType,
    timesliceMs: CHUNK_TIMESLICE_MS,
  };
  state.nextChunkSeq = 1;

  try {
    await createRecordingSession(state.recordingSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recording-store] failed to create recording session sessionId=${sessionId} error=${message}`);
    await setRecordingSessionError(sessionId);
    throw new Error('Failed to create recording session in IndexedDB.');
  }

  recorder.ondataavailable = (event) => {
    const blob = event.data;
    if (!blob || blob.size === 0) {
      return;
    }

    void persistChunk(blob);
  };

  recorder.onerror = () => {
    publishError('Audio recorder error.');
  };

  recorder.onstop = () => {
    if (state.recorder === recorder) {
      state.recorder = null;
    }
  };

  recorder.start(CHUNK_TIMESLICE_MS);

  state.recorder = recorder;
  startDiagnosticsTimer();
  const sourceDetail =
    state.selectedSource === 'tab' ? 'active tab audio' : state.selectedSource === 'mix' ? `tab + mic (${state.selectedDeviceId})` : state.selectedDeviceId;
  updateStatus('Listening', `Listening on ${sourceDetail}`);
}


chrome.runtime.onMessage.addListener((rawMessage: RuntimeMessage, _sender, sendResponse) => {
  const message = rawMessage;

  if (message?.type === 'GET_AUDIO_STATE') {
    sendResponse({
      status: state.status,
      selectedDeviceId: state.selectedDeviceId,
      selectedSource: state.selectedSource,
      seq: state.seq,
      detail: state.detail,
      transcript: state.transcript,
      diagnostics: computeDiagnostics(),
    });
    return;
  }

  if (message?.type === 'START_RECORDING') {
    startRecording(message.payload?.deviceId, message.payload?.source, message.payload?.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === 'REFRESH_SETTINGS') {
    refreshSttRuntimeSettings()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }

  if (message?.type === 'STOP_RECORDING') {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
        sendResponse({ ok: false, error: messageText });
      });
    return true;
  }
});


void refreshSttRuntimeSettings().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.info(`STT: initial settings refresh failed: ${message}`);
});
