export type DefaultSource = 'microphone' | 'tab';
export type SttProvider = 'mock' | 'openai';
export type StorageAreaName = 'local' | 'sync' | 'localStorage' | 'none';
export type StorageBackendName = 'chrome.storage.local' | 'chrome.storage.sync' | 'localStorage';
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
  backend: StorageBackendName;
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
  backend: StorageBackendName;
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

function getStorageAreas(): { local?: chrome.storage.StorageArea; sync?: chrome.storage.StorageArea } | null {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return null;
  }

  if (!chrome.storage.local && !chrome.storage.sync) {
    return null;
  }

  return {
    local: chrome.storage.local,
    sync: chrome.storage.sync,
  };
}

export function isExtensionContext(): boolean {
  try {
    return (
      (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') ||
      Boolean(globalThis.chrome?.runtime?.id)
    );
  } catch {
    return false;
  }
}

export function resolveStorageBackend(): StorageBackendName {
  if (!isExtensionContext()) {
    return 'localStorage';
  }

  if (globalThis.chrome?.storage?.local) {
    return 'chrome.storage.local';
  }

  if (globalThis.chrome?.storage?.sync) {
    return 'chrome.storage.sync';
  }

  return 'localStorage';
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

function cloneDefaults(): ExtensionSettings {
  return { ...defaults, stt: { ...defaults.stt } };
}

function getAreaByBackend(
  backend: StorageBackendName,
  areas: { local?: chrome.storage.StorageArea; sync?: chrome.storage.StorageArea } | null,
): chrome.storage.StorageArea | null {
  if (!areas) {
    return null;
  }

  if (backend === 'chrome.storage.local') {
    return areas.local ?? null;
  }

  if (backend === 'chrome.storage.sync') {
    return areas.sync ?? null;
  }

  return null;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const backend = resolveStorageBackend();

  if (backend === 'chrome.storage.local' || backend === 'chrome.storage.sync') {
    const storage = getAreaByBackend(backend, getStorageAreas());
    if (!storage) {
      return cloneDefaults();
    }

    const items = await storageGet(storage, [SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS]);
    const lookup = parseStorageLookup(items);
    const normalized = normalizeSettings(lookup.settings);

    if (JSON.stringify(lookup.settings) !== JSON.stringify(normalized) || lookup.detectedFrom !== 'none') {
      await persistCanonicalSettings(storage, normalized);
    }

    return normalized;
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return cloneDefaults();
  }

  try {
    const normalized = normalizeSettings(JSON.parse(raw) as LegacySettings);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return cloneDefaults();
  }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const backend = resolveStorageBackend();

  if (backend === 'chrome.storage.local' || backend === 'chrome.storage.sync') {
    const storage = getAreaByBackend(backend, getStorageAreas());
    if (!storage) {
      return;
    }

    await persistCanonicalSettings(storage, normalized);
    return;
  }

  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
}

export async function loadSttSettings(): Promise<SttSettingsLoadResult> {
  const backend = resolveStorageBackend();

  if (backend === 'chrome.storage.local' || backend === 'chrome.storage.sync') {
    const areas = getStorageAreas();
    const primaryStorage = getAreaByBackend(backend, areas);
    const localStorageArea = areas?.local;
    const syncStorageArea = areas?.sync;

    const lookupStorageAreas: Array<{ area: chrome.storage.StorageArea; areaName: StorageAreaName; backendName: StorageBackendName }> = [];

    if (primaryStorage && backend === 'chrome.storage.local') {
      lookupStorageAreas.push({ area: primaryStorage, areaName: 'local', backendName: 'chrome.storage.local' });
      if (syncStorageArea) {
        lookupStorageAreas.push({ area: syncStorageArea, areaName: 'sync', backendName: 'chrome.storage.sync' });
      }
    } else if (primaryStorage && backend === 'chrome.storage.sync') {
      lookupStorageAreas.push({ area: primaryStorage, areaName: 'sync', backendName: 'chrome.storage.sync' });
      if (localStorageArea) {
        lookupStorageAreas.push({ area: localStorageArea, areaName: 'local', backendName: 'chrome.storage.local' });
      }
    }

    for (const candidate of lookupStorageAreas) {
      const items = await storageGet(candidate.area, [SETTINGS_STORAGE_KEY, ...LEGACY_STT_KEYS]);
      const lookup = parseStorageLookup(items);

      if (!lookup.hasAnySttData) {
        continue;
      }

      const normalized = normalizeSettings(lookup.settings);
      const migrationTarget = localStorageArea ?? primaryStorage;
      if (migrationTarget) {
        const targetSettings = await loadSettings();
        await persistCanonicalSettings(migrationTarget, {
          ...targetSettings,
          stt: normalized.stt,
        });

        if (candidate.area !== migrationTarget) {
          await storageRemove(candidate.area, [...LEGACY_STT_KEYS]);
        }
      }

      return {
        ...normalized.stt,
        detectedFrom: lookup.detectedFrom,
        storageArea: candidate.areaName,
        backend: localStorageArea ? 'chrome.storage.local' : candidate.backendName,
      };
    }

    return {
      provider: 'mock',
      detectedFrom: 'none',
      storageArea: 'none',
      backend,
    };
  }

  const settings = await loadSettings();

  return {
    ...settings.stt,
    detectedFrom: settings.stt.apiKey ? 'settings.stt.apiKey' : 'none',
    storageArea: 'localStorage',
    backend: 'localStorage',
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
    backend: stt.backend,
    detectedFrom: stt.detectedFrom,
  };
}
