import {
  appendRecordingChunk,
  appendSessionSegment,
  createRecordingSession,
  createSession,
  listRecordingChunksBySession,
  type RecordingSessionRecord,
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

async function appendTranscript(seq: number, text: string): Promise<void> {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }

  if (state.activeSessionId) {
    const persisted = await appendSessionSegment(state.activeSessionId, normalized);
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

async function transcribeFullRecording(blob: Blob): Promise<void> {
  const apiKey = inMemoryApiKey;

  const uploadSeq = 1;

  if (blob.size === 0) {
    console.info(`STT: chunk ${uploadSeq} skipped (empty) size=${blob.size} type=${blob.type || 'unknown'}`);
    return;
  }

  if (blob.size < CHUNK_MIN_BYTES) {
    console.info(`STT: chunk ${uploadSeq} skipped (too-small) size=${blob.size} type=${blob.type || 'unknown'}`);
    return;
  }

  const filename = getChunkFilename(uploadSeq, blob.type || '');

  if (state.useMockTranscription) {
    await appendTranscript(uploadSeq, `[mock] chunk ${uploadSeq} text`);
    return;
  }

  if (!apiKey) {
    publishError('Missing OpenAI API key for REAL transcription mode.');
    return;
  }

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_RETRIES; attempt += 1) {
    try {
      console.info(`STT: uploading full recording size=${blob.size} type=${blob.type || 'unknown'} filename=${filename}`);
      console.info(
        `STT: preparing chunk ${uploadSeq} size=${blob.size} type=${blob.type || 'unknown'} filename=${filename} (attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES})`,
      );
      const text = await transcribeAudioBlob(blob, {
        apiKey,
        model: 'whisper-1',
        fileName: filename,
        maxRetries: 1,
      });

      console.info(`STT: received response for chunk ${uploadSeq}`);
      await appendTranscript(uploadSeq, text || `[empty] chunk ${uploadSeq}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof WhisperApiError ? error.status : 'unknown';
      const apiMessage = error instanceof WhisperApiError ? error.apiMessage : message;
      console.error(
        `STT: error for chunk ${uploadSeq} status=${status} size=${blob.size} type=${blob.type || 'unknown'} filename=${filename} (attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES})`,
        apiMessage,
      );

      if (
        error instanceof WhisperApiError &&
        error.status === 400 &&
        error.apiMessage.toLowerCase().includes('invalid file format')
      ) {
        await appendTranscript(uploadSeq, `[skipped] chunk ${uploadSeq} invalid file format`);
        return;
      }

      if (error instanceof WhisperApiError && error.status !== 429 && error.status < 500) {
        await appendTranscript(uploadSeq, `[failed] chunk ${uploadSeq} status ${error.status}`);
        publishError(`Chunk ${uploadSeq} failed with status ${error.status}.`);
        return;
      }

      if (attempt >= TRANSCRIBE_MAX_RETRIES) {
        await appendTranscript(uploadSeq, `[failed] chunk ${uploadSeq} after ${TRANSCRIBE_MAX_RETRIES} attempts`);
        publishError(`Chunk ${uploadSeq} failed after ${TRANSCRIBE_MAX_RETRIES} attempts.`);
        return;
      }

      const backoffMs = TRANSCRIBE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
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

  if (recordingSession && recordingSession.chunkCount > 0) {
    updateStatus('Transcribing', 'Transcribing recording...');

    try {
      const persistedChunks = await listRecordingChunksBySession(recordingSession.sessionId);
      const recorderMimeType = recorder?.mimeType || persistedChunks[0]?.mimeType || recordingSession.mimeType || 'audio/webm';
      const fullBlob = new Blob(
        persistedChunks.map((chunk) => chunk.blob),
        { type: recorderMimeType || 'audio/webm' },
      );
      await transcribeFullRecording(fullBlob);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      status: 'stopped',
    });
    state.activeSessionId = null;
  }

  stopDiagnosticsTimer();
  state.recordingSession = null;
  state.nextChunkSeq = 1;

  updateStatus('Stopped', 'Stopped');
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
