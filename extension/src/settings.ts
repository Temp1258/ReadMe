export type DefaultSource = 'microphone' | 'tab';
export type SttProvider = 'mock' | 'openai';
export type StorageAreaName = 'local' | 'sync' | 'localStorage' | 'none';
export type SttDetectedFrom =
  | 'settings.stt.apiKey'
  | 'sttApiKey'
  | 'sttapikey'
  | 'whisperApiKey'
  | 'openaiApiKey'
  | 'apiKey'
  | 'apikey'
  | 'none';

export type SttSettings = {
  provider: SttProvider;
  apiKey?: string;
};

export type SttSettingsLoadResult = SttSettings & {
  detectedFrom: SttDetectedFrom;
  storageArea: StorageAreaName;
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
  configured: boolean;
  provider: SttProvider;
  last4?: string;
  storageArea: StorageAreaName;
  detectedFrom: SttDetectedFrom;
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

function getStorageAreas(): { local: chrome.storage.StorageArea; sync?: chrome.storage.StorageArea } | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }

  return {
    local: chrome.storage.local,
    sync: chrome.storage.sync,
  };
}

async function storageGet(storage: chrome.storage.StorageArea, keys: string[]): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    storage.get(keys, (result) => resolve(result as Record<string, unknown>));
  });
}

async function storageSet(storage: chrome.storage.StorageArea, payload: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    storage.set(payload, () => resolve());
  });
}

async function storageRemove(storage: chrome.storage.StorageArea, keys: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    storage.remove(keys, () => resolve());
  });
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
  const provider: SttProvider = apiKey ? 'openai' : configuredProvider === 'openai' || configuredProvider === 'mock' ? configuredProvider : 'mock';

  return {
    defaultSource: settings.defaultSource === 'tab' ? 'tab' : defaults.defaultSource,
    stt: {
      provider,
      ...(provider === 'openai' && apiKey ? { apiKey } : {}),
    },
  };
}

type StorageLookupResult = {
  settings: LegacySettings;
  detectedFrom: SttDetectedFrom;
  hasAnySttData: boolean;
};

function parseStorageLookup(items: Record<string, unknown>): StorageLookupResult {
  const settings = (items[SETTINGS_STORAGE_KEY] as LegacySettings | undefined) ?? {};
  const nestedApiKey = settings.stt?.apiKey?.trim() ?? '';

  if (nestedApiKey) {
    return { settings, detectedFrom: 'settings.stt.apiKey', hasAnySttData: true };
  }

  for (const key of LEGACY_STT_KEYS) {
    const value = typeof items[key] === 'string' ? (items[key] as string).trim() : '';
    if (value) {
      return {
        settings: {
          ...settings,
          [key]: value,
        },
        detectedFrom: key,
        hasAnySttData: true,
      };
    }
  }

  const hasProvider = settings.stt?.provider === 'mock' || settings.stt?.provider === 'openai';
  return { settings, detectedFrom: 'none', hasAnySttData: hasProvider };
}

async function persistCanonicalSettings(storage: chrome.storage.StorageArea, settings: ExtensionSettings): Promise<void> {
  await storageSet(storage, { [SETTINGS_STORAGE_KEY]: settings });
  await storageRemove(storage, [...LEGACY_STT_KEYS]);
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const areas = getStorageAreas();

  if (!areas) {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...defaults, stt: { ...defaults.stt } };
    }

    try {
      const normalized = normalizeSettings(JSON.parse(raw) as LegacySettings);
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    } catch {
      return { ...defaults, stt: { ...defaults.stt } };
    }
  }

  const items = await storageGet(areas.local, [SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS]);
  const lookup = parseStorageLookup(items);
  const normalized = normalizeSettings(lookup.settings);

  if (JSON.stringify(lookup.settings) !== JSON.stringify(normalized) || lookup.detectedFrom !== 'none') {
    await persistCanonicalSettings(areas.local, normalized);
  }

  return normalized;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const areas = getStorageAreas();

  if (!areas) {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return;
  }

  await persistCanonicalSettings(areas.local, normalized);
}

export async function loadSttSettings(): Promise<SttSettingsLoadResult> {
  const areas = getStorageAreas();

  if (!areas) {
    const settings = await loadSettings();
    return {
      ...settings.stt,
      detectedFrom: settings.stt.apiKey ? 'settings.stt.apiKey' : 'none',
      storageArea: 'localStorage',
    };
  }

  const localItems = await storageGet(areas.local, [SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS]);
  const localLookup = parseStorageLookup(localItems);

  if (localLookup.hasAnySttData) {
    const normalized = normalizeSettings(localLookup.settings);
    if (localLookup.detectedFrom !== 'settings.stt.apiKey') {
      await persistCanonicalSettings(areas.local, {
        ...(await loadSettings()),
        stt: normalized.stt,
      });
    }

    return {
      ...normalized.stt,
      detectedFrom: localLookup.detectedFrom,
      storageArea: 'local',
    };
  }

  if (areas.sync) {
    const syncItems = await storageGet(areas.sync, [SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS]);
    const syncLookup = parseStorageLookup(syncItems);

    if (syncLookup.hasAnySttData) {
      const normalizedSync = normalizeSettings(syncLookup.settings);
      const localSettings = await loadSettings();
      await persistCanonicalSettings(areas.local, {
        ...localSettings,
        stt: normalizedSync.stt,
      });
      await storageRemove(areas.sync, [...LEGACY_STT_KEYS]);

      return {
        ...normalizedSync.stt,
        detectedFrom: syncLookup.detectedFrom,
        storageArea: 'sync',
      };
    }
  }

  return {
    provider: 'mock',
    detectedFrom: 'none',
    storageArea: 'none',
  };
}

export async function saveSttSettings(stt: { apiKey?: string; provider?: SttProvider }): Promise<void> {
  const settings = await loadSettings();
  const nextApiKey = stt.apiKey?.trim() ?? '';
  const nextStt: SttSettings =
    stt.provider === 'mock'
      ? { provider: 'mock' }
      : nextApiKey
        ? { provider: 'openai', apiKey: nextApiKey }
        : { provider: 'mock' };

  await saveSettings({
    ...settings,
    stt: nextStt,
  });
}

export async function getSttCredentialSummary(): Promise<SttCredentialSummary> {
  const stt = await loadSttSettings();
  const apiKey = stt.apiKey?.trim() ?? '';
  const configured = stt.provider === 'openai' && Boolean(apiKey);

  return {
    configured,
    provider: configured ? 'openai' : 'mock',
    ...(configured ? { last4: apiKey.slice(-4) } : {}),
    storageArea: stt.storageArea,
    detectedFrom: stt.detectedFrom,
  };
}
