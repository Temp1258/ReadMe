import type { RecordingSessionRecord } from '../db/indexeddb';
import { updateSessionState } from '../db/indexeddb';

export type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Stopped' | 'Error';
export type PersistedStatus = 'idle' | 'listening' | 'transcribing' | 'stopped' | 'error';
export type AudioSource = 'mic' | 'tab' | 'mix';

export type RecordingDiagnostics = {
  durationSec: number;
  durationLabel: string;
  totalBytes: number;
  totalMB: number;
  mbPerMin: number;
  estMinTo25MB: number | null;
  transcribedChunks: number;
  totalChunksToTranscribe: number;
};

export type RuntimeEventMessage =
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

export type GetSttSettingsResponse =
  | {
      ok: true;
      provider: 'openai' | 'mock' | 'deepgram' | 'siliconflow';
      keyPresent: boolean;
      apiKey?: string;
      deepgramApiKey?: string;
      siliconflowApiKey?: string;
    }
  | { ok: false; error: string };

export const state = {
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
  liveTranscribeEnabled: true,
  liveTranscribeQueue: [] as Array<{ blob: Blob; seq: number; createdAt: number }>,
  liveTranscribeRunning: false,
  webmHeader: null as Uint8Array | null,
  webmHeaderExtracted: false,
  transcribedChunks: 0,
  totalChunksToTranscribe: 0,
};

export let inMemoryApiKey: string | null = null;
export let inMemoryDeepgramApiKey: string | null = null;
export let inMemorySiliconflowApiKey: string | null = null;
export let activeProvider: 'openai' | 'mock' | 'deepgram' | 'siliconflow' = 'mock';

export function setInMemoryApiKey(key: string | null): void {
  inMemoryApiKey = key;
}

export function setInMemoryDeepgramApiKey(key: string | null): void {
  inMemoryDeepgramApiKey = key;
}

export function setInMemorySiliconflowApiKey(key: string | null): void {
  inMemorySiliconflowApiKey = key;
}

export function setActiveProvider(provider: 'openai' | 'mock' | 'deepgram' | 'siliconflow'): void {
  activeProvider = provider;
}

export function toPersistedStatus(status: AudioStatus): PersistedStatus {
  if (status === 'Listening') return 'listening';
  if (status === 'Transcribing') return 'transcribing';
  if (status === 'Error') return 'error';
  if (status === 'Stopped') return 'stopped';
  return 'idle';
}

export function formatDurationLabel(durationSec: number): string {
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function computeDiagnostics(): RecordingDiagnostics {
  const recordingSession = state.recordingSession;
  if (!recordingSession) {
    return {
      durationSec: 0,
      durationLabel: '00:00',
      totalBytes: 0,
      totalMB: 0,
      mbPerMin: 0,
      estMinTo25MB: null,
      transcribedChunks: state.transcribedChunks,
      totalChunksToTranscribe: state.totalChunksToTranscribe,
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
    transcribedChunks: state.transcribedChunks,
    totalChunksToTranscribe: state.totalChunksToTranscribe,
  };
}

export function broadcast(message: RuntimeEventMessage): void {
  if (!chrome.runtime?.id) {
    return;
  }

  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open.
  });
}

export function updateStatus(status: AudioStatus, detail?: string): void {
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

export function publishError(message: string): void {
  updateStatus('Error', message);
  broadcast({ type: 'ERROR', payload: { message } });
}

export async function refreshSttRuntimeSettings(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: 'GET_STT_SETTINGS' })) as GetSttSettingsResponse;

  if (!response?.ok) {
    const message = response?.error ?? 'Unable to fetch STT settings';
    setInMemoryApiKey(null);
    setInMemoryDeepgramApiKey(null);
    setInMemorySiliconflowApiKey(null);
    setActiveProvider('mock');
    state.useMockTranscription = true;
    console.info(`STT: settings unavailable error=${message}`);
    return;
  }

  const providerId = response.provider;
  const apiKey = response.apiKey ?? '';
  const deepgramApiKey = response.deepgramApiKey ?? '';
  const siliconflowApiKey = response.siliconflowApiKey ?? '';
  const keyPresent = apiKey.trim().length > 0;
  const deepgramKeyPresent = deepgramApiKey.trim().length > 0;
  const siliconflowKeyPresent = siliconflowApiKey.trim().length > 0;

  if (providerId === 'openai' && keyPresent) {
    setInMemoryApiKey(apiKey);
    setInMemoryDeepgramApiKey(null);
    setInMemorySiliconflowApiKey(null);
    setActiveProvider('openai');
    state.useMockTranscription = false;
  } else if (providerId === 'deepgram' && deepgramKeyPresent) {
    setInMemoryApiKey(null);
    setInMemoryDeepgramApiKey(deepgramApiKey);
    setInMemorySiliconflowApiKey(null);
    setActiveProvider('deepgram');
    state.useMockTranscription = false;
  } else if (providerId === 'siliconflow' && siliconflowKeyPresent) {
    setInMemoryApiKey(null);
    setInMemoryDeepgramApiKey(null);
    setInMemorySiliconflowApiKey(siliconflowApiKey);
    setActiveProvider('siliconflow');
    state.useMockTranscription = false;
  } else {
    setInMemoryApiKey(null);
    setInMemoryDeepgramApiKey(null);
    setInMemorySiliconflowApiKey(null);
    setActiveProvider('mock');
    state.useMockTranscription = true;
  }

  console.info(`STT: provider=${providerId} mock=${state.useMockTranscription}`);
}
