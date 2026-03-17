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
      provider: 'openai' | 'mock';
      keyPresent: boolean;
      apiKey?: string;
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
};

export let inMemoryApiKey: string | null = null;

export function setInMemoryApiKey(key: string | null): void {
  inMemoryApiKey = key;
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
    state.useMockTranscription = true;
    console.info(`STT: settings unavailable error=${message}`);
    return;
  }

  const providerId = response.provider;
  const apiKey = response.apiKey ?? '';
  const keyPresent = apiKey.trim().length > 0;
  const shouldUseRealTranscription = response.provider === 'openai' && response.keyPresent === true && keyPresent;

  setInMemoryApiKey(shouldUseRealTranscription ? apiKey : null);
  state.useMockTranscription = !shouldUseRealTranscription;

  console.info(
    `STT: providerId=${providerId} responseProvider=${response.provider} responseKeyPresent=${response.keyPresent} canonicalKeyPresent=${keyPresent}`,
  );

  if (providerId === 'openai' && !response.keyPresent) {
    console.info('STT: OpenAI selected but API key is empty; using MOCK mode');
  }

  console.info(state.useMockTranscription ? 'STT: using MOCK mode' : 'STT: using REAL mode');
}
