export type DefaultSource = 'microphone' | 'tab';

export type ExtensionSettings = {
  sttApiKey?: string;
  sttapikey?: string;
  whisperApiKey?: string;
  openaiApiKey?: string;
  apiKey?: string;
  apikey?: string;
  defaultSource?: DefaultSource;
};

export type ApiKeyFieldName = 'sttApiKey' | 'sttapikey' | 'whisperApiKey' | 'openaiApiKey' | 'apiKey' | 'apikey';

export type NormalizedApiKey = {
  apiKey: string;
  fieldName: ApiKeyFieldName | null;
};

export const SETTINGS_STORAGE_KEY = 'settings';

export const defaults: Required<Pick<ExtensionSettings, 'defaultSource'>> = {
  defaultSource: 'microphone',
};

function getStorageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return chrome.storage.local;
}

function normalizeSettings(settings: ExtensionSettings): ExtensionSettings {
  const normalized: ExtensionSettings = {
    defaultSource: settings.defaultSource === 'tab' ? 'tab' : defaults.defaultSource,
  };

  const normalizedApiKey = getNormalizedApiKey(settings);
  if (normalizedApiKey.apiKey) {
    normalized.whisperApiKey = normalizedApiKey.apiKey;
  }

  return normalized;
}

export function getNormalizedApiKey(settings: ExtensionSettings): NormalizedApiKey {
  const candidates: ApiKeyFieldName[] = ['sttApiKey', 'sttapikey', 'whisperApiKey', 'openaiApiKey', 'apiKey', 'apikey'];

  for (const fieldName of candidates) {
    const value = settings[fieldName]?.trim();
    if (value) {
      return {
        apiKey: value,
        fieldName,
      };
    }
  }

  return {
    apiKey: '',
    fieldName: null,
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const storage = getStorageArea();

  if (!storage) {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...defaults };
    }

    try {
      const settings = JSON.parse(raw) as ExtensionSettings;
      const normalized = normalizeSettings(settings);

      if (JSON.stringify(settings) !== JSON.stringify(normalized)) {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
      }

      return normalized;
    } catch {
      return { ...defaults };
    }
  }

  return new Promise((resolve) => {
    storage.get([SETTINGS_STORAGE_KEY, 'sttApiKey', 'sttapikey', 'whisperApiKey', 'openaiApiKey', 'apiKey', 'apikey'], (items) => {
      const storedSettings = (items[SETTINGS_STORAGE_KEY] as ExtensionSettings | undefined) ?? {};

      const settings: ExtensionSettings = {
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
