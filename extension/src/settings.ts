export type DefaultSource = 'microphone' | 'tab';

export type ExtensionSettings = {
  whisperApiKey?: string;
  defaultSource?: DefaultSource;
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

  const whisperApiKey = settings.whisperApiKey?.trim();
  if (whisperApiKey) {
    normalized.whisperApiKey = whisperApiKey;
  }

  return normalized;
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
