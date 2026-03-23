export type AudioStatus = 'Idle' | 'Listening' | 'Transcribing' | 'Stopped' | 'Error';
export type AppView = 'transcription' | 'notes' | 'settings';
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

export type UITheme = 'light' | 'dark';
export type UILang = 'en' | 'zh';

export type DeviceOption = {
  id: string;
  label: string;
};

export type RuntimeEventMessage =
  | { type: 'TRANSCRIPT_UPDATE'; payload: { seq: number; text: string; transcript: string } }
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
  | { type: 'ERROR'; payload: { message: string } }
  | { type: 'WARNING'; payload: { message: string } };

export type GetSttSettingsResponse =
  | {
      ok: true;
      provider: 'openai' | 'deepgram' | 'siliconflow' | 'mock';
      keyPresent: boolean;
      apiKey?: string;
      deepgramApiKey?: string;
      siliconflowApiKey?: string;
    }
  | {
      ok: false;
      error: string;
    };
