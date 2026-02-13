import { appendSessionSegment, createSession, updateSessionState } from './db/indexeddb';
import { transcribeAudioBlob } from './stt/whisper';

export {};

type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Error';
type PersistedStatus = 'idle' | 'listening' | 'transcribing' | 'stopped' | 'error';
type AudioSource = 'mic' | 'tab';

type RuntimeMessage =
  | { type: 'PING' }
  | { type: 'GET_AUDIO_STATE' }
  | { type: 'START_RECORDING'; payload?: { deviceId?: string; source?: AudioSource; streamId?: string } }
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
const MOCK_SEGMENT_INTERVAL_MS = 2_000;
const STT_API_KEY_STORAGE_KEY = 'sttApiKey';

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
  mockSegmentTimer: null as number | null,
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

async function getStoredApiKey(): Promise<string> {
  if (!chrome.storage?.local) {
    return '';
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(STT_API_KEY_STORAGE_KEY, (items) => {
      resolve((items[STT_API_KEY_STORAGE_KEY] as string | undefined)?.trim() ?? '');
    });
  });
}

function enqueueChunk(blob: Blob): void {
  const nextSeq = state.seq + 1;
  state.seq = nextSeq;
  state.queue.push({ seq: nextSeq, blob });
  void processQueue();
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
  const apiKey = await getStoredApiKey();

  if (!apiKey) {
    await appendTranscript(job.seq, `[mock] chunk ${job.seq} text`);
    return;
  }

  const text = await transcribeAudioBlob(job.blob, {
    apiKey,
    model: 'whisper-1',
    fileName: `chunk-${job.seq}.webm`,
  });

  await appendTranscript(job.seq, text || `[empty] chunk ${job.seq}`);
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

function stopMockSegmentTimer(): void {
  if (state.mockSegmentTimer === null) {
    return;
  }

  window.clearInterval(state.mockSegmentTimer);
  state.mockSegmentTimer = null;
}

async function stopRecording(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = null;
  stopMockSegmentTimer();

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

  if (state.activeSessionId) {
    void updateSessionState(state.activeSessionId, {
      endedAt: Date.now(),
      status: 'stopped',
    });
    state.activeSessionId = null;
  }

  updateStatus('Idle', 'Idle');
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
  const apiKey = await getStoredApiKey();
  state.useMockTranscription = !apiKey;

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

  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (state.useMockTranscription) {
      return;
    }

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

  if (state.useMockTranscription) {
    const appendMockSegment = () => {
      const nextSeq = state.seq + 1;
      state.seq = nextSeq;
      void appendTranscript(nextSeq, `[mock] chunk ${nextSeq} text`);
    };

    appendMockSegment();
    state.mockSegmentTimer = window.setInterval(appendMockSegment, MOCK_SEGMENT_INTERVAL_MS);
    recorder.start();
  } else {
    recorder.start(CHUNK_TIMESLICE_MS);
  }

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
    startRecording(message.payload?.deviceId, message.payload?.source, message.payload?.streamId)
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
