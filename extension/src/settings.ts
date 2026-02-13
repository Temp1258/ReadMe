export type DefaultSource = 'microphone' | 'tab';

export type ExtensionSettings = {
  sttApiKey?: string;
  whisperApiKey?: string;
  openaiApiKey?: string;
  apiKey?: string;
  apikey?: string;
  defaultSource?: DefaultSource;
};

export type ApiKeyFieldName = 'sttApiKey' | 'whisperApiKey' | 'openaiApiKey' | 'apiKey' | 'apikey';

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
  const candidates: ApiKeyFieldName[] = ['sttApiKey', 'whisperApiKey', 'openaiApiKey', 'apiKey', 'apikey'];

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
      return normalizeSettings(JSON.parse(raw) as ExtensionSettings);
    } catch {
      return { ...defaults };
    }
  }

  return new Promise((resolve) => {
    storage.get(SETTINGS_STORAGE_KEY, (items) => {
      const settings = (items[SETTINGS_STORAGE_KEY] as ExtensionSettings | undefined) ?? {};
      resolve(normalizeSettings(settings));
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
