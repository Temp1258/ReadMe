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

export type ApiKeyFieldName = 'stt.apiKey' | 'sttApiKey' | 'sttapikey' | 'whisperApiKey' | 'openaiApiKey' | 'apiKey' | 'apikey';

export type NormalizedApiKey = {
  apiKey: string;
  fieldName: ApiKeyFieldName | null;
};

export type SttCredentialSummary = {
  provider: SttProvider;
  apiKey: string;
  maskedApiKey: string;
  keyPresent: boolean;
};

export const SETTINGS_STORAGE_KEY = 'settings';

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

export function getNormalizedApiKey(settings: LegacySettings): NormalizedApiKey {
  const candidates: Array<{ fieldName: ApiKeyFieldName; value: string | undefined }> = [
    { fieldName: 'stt.apiKey', value: settings.stt?.apiKey },
    { fieldName: 'sttApiKey', value: settings.sttApiKey },
    { fieldName: 'sttapikey', value: settings.sttapikey },
    { fieldName: 'whisperApiKey', value: settings.whisperApiKey },
    { fieldName: 'openaiApiKey', value: settings.openaiApiKey },
    { fieldName: 'apiKey', value: settings.apiKey },
    { fieldName: 'apikey', value: settings.apikey },
  ];

  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    if (value) {
      return {
        apiKey: value,
        fieldName: candidate.fieldName,
      };
    }
  }

  return {
    apiKey: '',
    fieldName: null,
  };
}

function normalizeSettings(settings: LegacySettings): ExtensionSettings {
  const normalizedApiKey = getNormalizedApiKey(settings);
  const providerFromSettings = settings.stt?.provider;
  const provider: SttProvider =
    providerFromSettings === 'openai' || providerFromSettings === 'mock'
      ? providerFromSettings
      : normalizedApiKey.apiKey
        ? 'openai'
        : 'mock';

  const normalized: ExtensionSettings = {
    defaultSource: settings.defaultSource === 'tab' ? 'tab' : defaults.defaultSource,
    stt: {
      provider,
    },
  };

  if (normalizedApiKey.apiKey) {
    normalized.stt.apiKey = normalizedApiKey.apiKey;
  }

  if (provider === 'mock') {
    delete normalized.stt.apiKey;
  }

  return normalized;
}

export function getSttCredentialSummary(settings: ExtensionSettings): SttCredentialSummary {
  const apiKey = settings.stt.apiKey?.trim() ?? '';
  const keyPresent = Boolean(apiKey);
  const provider = settings.stt.provider === 'openai' && keyPresent ? 'openai' : 'mock';

  return {
    provider,
    apiKey: provider === 'openai' ? apiKey : '',
    keyPresent: provider === 'openai' && keyPresent,
    maskedApiKey: provider === 'openai' && keyPresent ? maskSecret(apiKey) : '',
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const storage = getStorageArea();

  if (!storage) {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...defaults, stt: { ...defaults.stt } };
    }

    try {
      const settings = JSON.parse(raw) as LegacySettings;
      const normalized = normalizeSettings(settings);

      if (JSON.stringify(settings) !== JSON.stringify(normalized)) {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
      }

      return normalized;
    } catch {
      return { ...defaults, stt: { ...defaults.stt } };
    }
  }

  return new Promise((resolve) => {
    storage.get([SETTINGS_STORAGE_KEY, 'sttApiKey', 'sttapikey', 'whisperApiKey', 'openaiApiKey', 'apiKey', 'apikey'], (items) => {
      const storedSettings = (items[SETTINGS_STORAGE_KEY] as LegacySettings | undefined) ?? {};

      const settings: LegacySettings = {
        ...storedSettings,
        sttApiKey: storedSettings.sttApiKey ?? (items.sttApiKey as string | undefined),
        sttapikey: storedSettings.sttapikey ?? (items.sttapikey as string | undefined),
        whisperApiKey: storedSettings.whisperApiKey ?? (items.whisperApiKey as string | undefined),
        openaiApiKey: storedSettings.openaiApiKey ?? (items.openaiApiKey as string | undefined),
        apiKey: storedSettings.apiKey ?? (items.apiKey as string | undefined),
        apikey: storedSettings.apikey ?? (items.apikey as string | undefined),
      };

      const normalized = normalizeSettings(settings);
      const shouldPersist = JSON.stringify(storedSettings) !== JSON.stringify(normalized);

      if (!shouldPersist) {
        resolve(normalized);
        return;
      }

      storage.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => resolve(normalized));
    });
  });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const storage = getStorageArea();

  if (!storage) {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return;
  }

  await new Promise<void>((resolve) => {
    storage.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => resolve());
  });
}
