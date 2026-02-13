import { appendSessionSegment, createSession, updateSessionState } from './db/indexeddb';
import { transcribeAudioBlob, WhisperApiError } from './stt/whisper';

export {};

type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Stopped' | 'Error';
type PersistedStatus = 'idle' | 'listening' | 'transcribing' | 'stopped' | 'error';
type AudioSource = 'mic' | 'tab';

type RuntimeMessage =
  | { type: 'PING' }
  | { type: 'GET_AUDIO_STATE' }
  | {
      type: 'START_RECORDING';
      payload?: { deviceId?: string; source?: AudioSource; streamId?: string; apiKey?: string; apiKeyFieldName?: string };
    }
  | { type: 'STOP_RECORDING' };

type RuntimeEventMessage =
  | { type: 'STATUS_UPDATE'; payload: { status: AudioStatus; detail?: string; selectedDeviceId: string; selectedSource: AudioSource; seq: number } }
  | { type: 'TRANSCRIPT_UPDATE'; payload: { seq: number; text: string; transcript: string } }
  | { type: 'ERROR'; payload: { message: string } };

type ChunkJob = {
  seq: number;
  blob: Blob;
};

const CHUNK_TIMESLICE_MS = 12_000;
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
  recorder: null as MediaRecorder | null,
  queue: [] as ChunkJob[],
  processingQueue: false,
  transcript: '',
  activeSessionId: null as string | null,
  useMockTranscription: false,
};

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
    },
  });
}

function publishError(message: string): void {
  updateStatus('Error', message);
  broadcast({ type: 'ERROR', payload: { message } });
}

async function stopTracks(): Promise<void> {
  if (!state.activeStream) {
    return;
  }

  state.activeStream.getTracks().forEach((track) => track.stop());
  state.activeStream = null;
}

function enqueueChunk(blob: Blob): void {
  const nextSeq = state.seq + 1;
  state.seq = nextSeq;
  state.queue.push({ seq: nextSeq, blob });
  void processQueue();
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

async function transcribeChunk(job: ChunkJob): Promise<void> {
  const apiKey = inMemoryApiKey;
  const blob = job.blob;

  if (!blob) {
    return;
  }

  if (blob.size === 0) {
    console.info(`STT: chunk ${job.seq} skipped (empty) size=${blob.size} type=${blob.type || 'unknown'}`);
    return;
  }

  if (blob.size < CHUNK_MIN_BYTES) {
    console.info(`STT: chunk ${job.seq} skipped (too-small) size=${blob.size} type=${blob.type || 'unknown'}`);
    return;
  }

  const filename = getChunkFilename(job.seq, blob.type || '');

  if (!apiKey) {
    await appendTranscript(job.seq, `[mock] chunk ${job.seq} text`);
    return;
  }

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_RETRIES; attempt += 1) {
    try {
      console.info(
        `STT: preparing chunk ${job.seq} size=${blob.size} type=${blob.type || 'unknown'} filename=${filename} (attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES})`,
      );
      const text = await transcribeAudioBlob(blob, {
        apiKey,
        model: 'whisper-1',
        fileName: filename,
        maxRetries: 1,
      });

      console.info(`STT: received response for chunk ${job.seq}`);
      await appendTranscript(job.seq, text || `[empty] chunk ${job.seq}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof WhisperApiError ? error.status : 'unknown';
      const apiMessage = error instanceof WhisperApiError ? error.apiMessage : message;
      console.error(
        `STT: error for chunk ${job.seq} status=${status} size=${blob.size} type=${blob.type || 'unknown'} filename=${filename} (attempt ${attempt}/${TRANSCRIBE_MAX_RETRIES})`,
        apiMessage,
      );

      if (
        error instanceof WhisperApiError &&
        error.status === 400 &&
        error.apiMessage.toLowerCase().includes('invalid file format')
      ) {
        await appendTranscript(job.seq, `[skipped] chunk ${job.seq} invalid file format`);
        return;
      }

      if (error instanceof WhisperApiError && error.status !== 429 && error.status < 500) {
        await appendTranscript(job.seq, `[failed] chunk ${job.seq} status ${error.status}`);
        publishError(`Chunk ${job.seq} failed with status ${error.status}.`);
        return;
      }

      if (attempt >= TRANSCRIBE_MAX_RETRIES) {
        await appendTranscript(job.seq, `[failed] chunk ${job.seq} after ${TRANSCRIBE_MAX_RETRIES} attempts`);
        publishError(`Chunk ${job.seq} failed after ${TRANSCRIBE_MAX_RETRIES} attempts.`);
        return;
      }

      const backoffMs = TRANSCRIBE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

async function processQueue(): Promise<void> {
  if (state.processingQueue) {
    return;
  }

  state.processingQueue = true;

  try {
    while (state.queue.length > 0) {
      const job = state.queue.shift();

      if (!job) {
        break;
      }

      updateStatus('Transcribing', `Transcribing chunk ${job.seq}...`);

      try {
        await transcribeChunk(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publishError(`Chunk ${job.seq} failed: ${message}`);
      }

      if (state.recorder && state.recorder.state !== 'inactive') {
        const sourceDetail = state.selectedSource === 'tab' ? 'active tab audio' : state.selectedDeviceId;
        updateStatus('Listening', `Listening on ${sourceDetail}`);
      }
    }
  } finally {
    state.processingQueue = false;
  }
}

async function stopRecording(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = null;

  if (recorder && recorder.state !== 'inactive') {
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    recorder.stop();
  }

  await stopTracks();
  state.queue = [];
  state.processingQueue = false;
  state.useMockTranscription = false;
  inMemoryApiKey = null;

  if (state.activeSessionId) {
    void updateSessionState(state.activeSessionId, {
      endedAt: Date.now(),
      status: 'stopped',
    });
    state.activeSessionId = null;
  }

  updateStatus('Stopped', 'Stopped');
}

async function getAudioStream(source: AudioSource, streamId?: string): Promise<MediaStream> {
  if (source === 'tab') {
    if (!streamId) {
      throw new Error('Missing tab capture stream id. Start from the popup Start button.');
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as MediaTrackConstraints,
      video: false,
    });
  }

  const audioConstraint = state.selectedDeviceId === 'default' ? true : { deviceId: { exact: state.selectedDeviceId } };

  return navigator.mediaDevices.getUserMedia({
    audio: audioConstraint,
    video: false,
  });
}

async function startRecording(deviceId?: string, source: AudioSource = 'mic', streamId?: string, apiKey?: string): Promise<void> {
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
  inMemoryApiKey = apiKey?.trim() || null;
  console.info(`STT: key present = ${Boolean(inMemoryApiKey)} (source=message)`);
  state.useMockTranscription = !inMemoryApiKey;
  console.info(state.useMockTranscription ? 'STT: using MOCK mode' : 'STT: using REAL mode');

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
  console.info(`STT: recorder mimeType=${recorder.mimeType || 'default'}`);
  recorder.ondataavailable = (event) => {
    const blob = event.data;
    if (!blob || blob.size === 0) {
      return;
    }

    enqueueChunk(blob);
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
  const sourceDetail = state.selectedSource === 'tab' ? 'active tab audio' : state.selectedDeviceId;
  updateStatus('Listening', `Listening on ${sourceDetail}`);
}

chrome.runtime.onMessage.addListener((rawMessage: RuntimeMessage, _sender, sendResponse) => {
  const message = rawMessage;

  if (message?.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return;
  }

  if (message?.type === 'GET_AUDIO_STATE') {
    sendResponse({
      status: state.status,
      selectedDeviceId: state.selectedDeviceId,
      selectedSource: state.selectedSource,
      seq: state.seq,
      detail: state.detail,
      transcript: state.transcript,
    });
    return;
  }

  if (message?.type === 'START_RECORDING') {
    startRecording(message.payload?.deviceId, message.payload?.source, message.payload?.streamId, message.payload?.apiKey)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        publishError(messageText);
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
