export type DefaultSource = 'microphone' | 'tab';
export type SttProvider = 'mock' | 'openai';

export type SttSettings = {
  provider: SttProvider;
  apiKey?: string;
};

export type ExtensionSettings = {
  stt: SttSettings;
  defaultSource: DefaultSource;
};

type LegacySettings = {
  stt?: Partial<SttSettings>;
  sttApiKey?: string;
  sttapikey?: string;
  whisperApiKey?: string;
  openaiApiKey?: string;
  apiKey?: string;
  apikey?: string;
  defaultSource?: DefaultSource;
};

export type SttCredentialSummary = {
  provider: SttProvider;
  keyPresent: boolean;
  maskedApiKey: string;
};

export const SETTINGS_STORAGE_KEY = 'settings';
const LEGACY_STT_KEYS = ['sttApiKey', 'sttapikey', 'whisperApiKey', 'openaiApiKey', 'apiKey', 'apikey'] as const;

export const defaults: ExtensionSettings = {
  defaultSource: 'microphone',
  stt: {
    provider: 'mock',
  },
};

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) {
    return '';
  }

  return `****${trimmed.slice(-4)}`;
}

function getStorageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return chrome.storage.local;
}

function normalizeSettings(settings: LegacySettings): ExtensionSettings {
  const nestedApiKey = settings.stt?.apiKey?.trim() ?? '';
  const legacyApiKey =
    settings.sttApiKey?.trim() ||
    settings.sttapikey?.trim() ||
    settings.whisperApiKey?.trim() ||
    settings.openaiApiKey?.trim() ||
    settings.apiKey?.trim() ||
    settings.apikey?.trim() ||
    '';
  const apiKey = nestedApiKey || legacyApiKey;

  const configuredProvider = settings.stt?.provider;
  const provider: SttProvider = configuredProvider === 'openai' || configuredProvider === 'mock' ? configuredProvider : apiKey ? 'openai' : 'mock';

  return {
    defaultSource: settings.defaultSource === 'tab' ? 'tab' : defaults.defaultSource,
    stt: {
      provider,
      ...(apiKey ? { apiKey } : {}),
    },
  };
}

async function persistSettings(storage: chrome.storage.StorageArea, settings: ExtensionSettings): Promise<void> {
  await new Promise<void>((resolve) => {
    storage.set({ [SETTINGS_STORAGE_KEY]: settings }, () => resolve());
  });

  await new Promise<void>((resolve) => {
    storage.remove([...LEGACY_STT_KEYS], () => resolve());
  });
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const storage = getStorageArea();

  if (!storage) {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...defaults, stt: { ...defaults.stt } };
    }

    try {
      const normalized = normalizeSettings(JSON.parse(raw) as LegacySettings);
      if (JSON.stringify(normalized) !== raw) {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
      }
      return normalized;
    } catch {
      return { ...defaults, stt: { ...defaults.stt } };
    }
  }

  const items = await new Promise<Record<string, unknown>>((resolve) => {
    storage.get([SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS] as string[], (result) => {
      resolve(result as Record<string, unknown>);
    });
  });

  const storedSettings = (items[SETTINGS_STORAGE_KEY] as LegacySettings | undefined) ?? {};
  const normalized = normalizeSettings({
    ...storedSettings,
    ...Object.fromEntries(LEGACY_STT_KEYS.map((key) => [key, items[key] as string | undefined])),
  });

  if (JSON.stringify(storedSettings) !== JSON.stringify(normalized) || LEGACY_STT_KEYS.some((key) => Boolean(items[key]))) {
    await persistSettings(storage, normalized);
  }

  return normalized;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return;
  }

  await persistSettings(storage, normalized);
}

export async function loadSttSettings(): Promise<SttSettings> {
  const settings = await loadSettings();
  return settings.stt;
}

export async function saveSttSettings(stt: SttSettings): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    stt,
  });
}

export async function getSttCredentialSummary(): Promise<SttCredentialSummary> {
  const stt = await loadSttSettings();
  const apiKey = stt.apiKey?.trim() ?? '';
  const keyPresent = Boolean(apiKey);
  const provider = stt.provider === 'openai' && keyPresent ? 'openai' : 'mock';

  return {
    provider,
    keyPresent: provider === 'openai' && keyPresent,
    maskedApiKey: provider === 'openai' && keyPresent ? maskSecret(apiKey) : '',
  };
}
