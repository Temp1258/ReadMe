import type { AudioSource, UITheme, UILang, AudioStatus, RecordingDiagnostics, GetSttSettingsResponse } from '../types';
import type { SessionStatus } from '../db/indexeddb';

const AUDIO_DEVICE_STORAGE_KEY = 'selectedAudioDeviceId';
const AUDIO_SOURCE_STORAGE_KEY = 'selectedAudioSource';
const UI_THEME_STORAGE_KEY = 'uiTheme';
const UI_LANG_STORAGE_KEY = 'uiLang';
export const OFFSCREEN_DOCUMENT_PATH = 'dist/src/offscreen.html';

type ChromeStorageArea = {
  get: (keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, callback?: () => void) => void;
  remove: (keys: string | string[], callback?: () => void) => void;
};

function getStorageArea(): ChromeStorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return chrome.storage.local;
}

export async function readSelectedDeviceId(): Promise<string> {
  const storage = getStorageArea();

  if (!storage) {
    return window.localStorage.getItem(AUDIO_DEVICE_STORAGE_KEY) ?? 'default';
  }

  return new Promise((resolve) => {
    storage.get(AUDIO_DEVICE_STORAGE_KEY, (items) => {
      resolve((items[AUDIO_DEVICE_STORAGE_KEY] as string | undefined) ?? 'default');
    });
  });
}

export async function readSelectedAudioSource(fallbackSource: AudioSource): Promise<AudioSource> {
  const storage = getStorageArea();

  if (!storage) {
    return (window.localStorage.getItem(AUDIO_SOURCE_STORAGE_KEY) as AudioSource | null) ?? fallbackSource;
  }

  return new Promise((resolve) => {
    storage.get(AUDIO_SOURCE_STORAGE_KEY, (items) => {
      const stored = items[AUDIO_SOURCE_STORAGE_KEY];
      if (stored === 'tab' || stored === 'mic' || stored === 'mix') {
        resolve(stored);
        return;
      }

      resolve(fallbackSource);
    });
  });
}

export async function persistSelectedAudioSource(source: AudioSource): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(AUDIO_SOURCE_STORAGE_KEY, source);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [AUDIO_SOURCE_STORAGE_KEY]: source }, () => resolve());
  });
}

export async function persistSelectedDeviceId(deviceId: string): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(AUDIO_DEVICE_STORAGE_KEY, deviceId);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [AUDIO_DEVICE_STORAGE_KEY]: deviceId }, () => resolve());
  });
}

export async function readUITheme(): Promise<UITheme> {
  const storage = getStorageArea();

  if (!storage) {
    const localTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
    return localTheme === 'dark' ? 'dark' : 'light';
  }

  return new Promise((resolve) => {
    storage.get(UI_THEME_STORAGE_KEY, (items) => {
      resolve(items[UI_THEME_STORAGE_KEY] === 'dark' ? 'dark' : 'light');
    });
  });
}

export async function persistUITheme(theme: UITheme): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [UI_THEME_STORAGE_KEY]: theme }, () => resolve());
  });
}

export async function readUILang(): Promise<UILang> {
  const storage = getStorageArea();

  if (!storage) {
    const localLang = window.localStorage.getItem(UI_LANG_STORAGE_KEY);
    return localLang === 'zh' ? 'zh' : 'en';
  }

  return new Promise((resolve) => {
    storage.get(UI_LANG_STORAGE_KEY, (items) => {
      resolve(items[UI_LANG_STORAGE_KEY] === 'zh' ? 'zh' : 'en');
    });
  });
}

export async function persistUILang(lang: UILang): Promise<void> {
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(UI_LANG_STORAGE_KEY, lang);
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [UI_LANG_STORAGE_KEY]: lang }, () => resolve());
  });
}

export { UI_THEME_STORAGE_KEY, UI_LANG_STORAGE_KEY };

type RuntimeContext = {
  contextType: string;
  documentUrl?: string;
};

export async function ensureOffscreenDocument(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.offscreen?.createDocument) {
    return;
  }

  const offscreenDocumentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const getContexts = chrome.runtime.getContexts as
    | ((query: { contextTypes: string[]; documentUrls: string[] }) => Promise<RuntimeContext[]>)
    | undefined;

  if (getContexts) {
    const contexts = await getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenDocumentUrl],
    });

    if (contexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capture audio and keep tab playback audible while recording runs offscreen.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('single offscreen document')) {
      throw error;
    }
  }
}

export async function getSttDiagnosticsFromRuntime(): Promise<{ providerLabel: string; configurationLabel: string; error?: string }> {
  const sendMessage = chrome.runtime?.sendMessage as ((message: { type: 'GET_STT_SETTINGS' }) => Promise<GetSttSettingsResponse>) | undefined;

  if (!sendMessage) {
    return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: 'Runtime messaging unavailable.' };
  }

  try {
    const response = await sendMessage({ type: 'GET_STT_SETTINGS' });
    if (!response.ok) {
      return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: response.error || 'Unable to read STT settings.' };
    }

    const providerLabel = response.provider === 'openai' ? 'OpenAI Whisper' : 'Mock';
    const configurationLabel = response.provider === 'openai' && response.keyPresent ? 'Configured' : 'Not configured';

    return { providerLabel, configurationLabel };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read STT settings.';
    return { providerLabel: 'Unknown', configurationLabel: 'Not configured', error: message };
  }
}

export async function queryStateFromOffscreen() {
  const sendMessage = chrome.runtime?.sendMessage as
    | ((message: { type: 'GET_AUDIO_STATE' }) => Promise<{
        status?: AudioStatus;
        detail?: string;
        selectedDeviceId?: string;
        selectedSource?: AudioSource;
        seq?: number;
        transcript?: string;
        diagnostics?: RecordingDiagnostics;
      }>)
    | undefined;

  if (!sendMessage) {
    return null;
  }

  return sendMessage({ type: 'GET_AUDIO_STATE' });
}

export function mapSessionStatusToAudioStatus(status: SessionStatus): AudioStatus {
  if (status === 'listening') {
    return 'Listening';
  }

  if (status === 'transcribing') {
    return 'Transcribing';
  }

  if (status === 'error') {
    return 'Error';
  }

  if (status === 'stopped') {
    return 'Stopped';
  }

  return 'Idle';
}
