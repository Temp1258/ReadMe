export type DefaultSource = 'microphone' | 'tab' | 'mix';
export type SttProvider = 'mock' | 'openai' | 'deepgram';
type StorageAreaName = 'local' | 'localStorage';
export type StorageBackendName = 'chrome.storage.local' | 'localStorage';
export type SttDetectedFrom = 'settings.stt.apiKey' | 'none';

export type SttSettings = {
  provider: SttProvider;
  apiKey?: string;
  deepgramApiKey?: string;
};

type SttSettingsLoadResult = SttSettings & {
  detectedFrom: SttDetectedFrom;
  storageArea: StorageAreaName;
  backend: StorageBackendName;
};

export type AiFeatureSettings = {
  summaryEnabled: boolean;
};

export type ExtensionSettings = {
  stt: SttSettings;
  defaultSource: DefaultSource;
  ai?: AiFeatureSettings;
};

type SttCredentialSummary = {
  configured: boolean;
  provider: SttProvider;
  last4?: string;
  backend: StorageBackendName;
  detectedFrom: SttDetectedFrom;
};

export const SETTINGS_STORAGE_KEY = 'settings';

function resolveSttProvider(provider: unknown): SttProvider {
  if (provider === 'openai') return 'openai';
  if (provider === 'deepgram') return 'deepgram';
  return 'mock';
}

function trimApiKey(apiKey: unknown): string {
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

function normalizeSettings(settings: Partial<ExtensionSettings> | null | undefined): ExtensionSettings {
  const defaultSource: DefaultSource =
    settings?.defaultSource === 'tab' || settings?.defaultSource === 'mix' ? settings.defaultSource : 'microphone';

  const apiKey = trimApiKey(settings?.stt?.apiKey);
  const deepgramApiKey = trimApiKey(settings?.stt?.deepgramApiKey);
  const requestedProvider = resolveSttProvider(settings?.stt?.provider);

  let provider: SttProvider;
  if (requestedProvider === 'openai' && apiKey) {
    provider = 'openai';
  } else if (requestedProvider === 'deepgram' && deepgramApiKey) {
    provider = 'deepgram';
  } else {
    provider = 'mock';
  }

  const stt: SttSettings =
    provider === 'openai'
      ? { provider, apiKey, deepgramApiKey: deepgramApiKey || undefined }
      : provider === 'deepgram'
        ? { provider, apiKey: apiKey || undefined, deepgramApiKey }
        : { provider: 'mock', apiKey: apiKey || undefined, deepgramApiKey: deepgramApiKey || undefined };

  const ai: AiFeatureSettings = {
    summaryEnabled: settings?.ai?.summaryEnabled ?? true,
  };

  return { defaultSource, stt, ai };
}

export const defaults: ExtensionSettings = normalizeSettings(undefined);

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) {
    return '';
  }

  return `****${trimmed.slice(-4)}`;
}

function isExtensionContext(): boolean {
  try {
    return (
      (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') ||
      Boolean(globalThis.chrome?.runtime?.id)
    );
  } catch {
    return false;
  }
}

function resolveStorageBackend(): StorageBackendName {
  if (isExtensionContext() && globalThis.chrome?.storage?.local) {
    return 'chrome.storage.local';
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

function cloneDefaults(): ExtensionSettings {
  return { ...defaults, stt: { ...defaults.stt } };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  let backend: StorageBackendName;
  try {
    backend = resolveStorageBackend();
  } catch {
    return cloneDefaults();
  }

  if (backend !== 'chrome.storage.local') {
    return cloneDefaults();
  }

  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    return cloneDefaults();
  }

  const items = await storageGet(storage, [SETTINGS_STORAGE_KEY]);
  return normalizeSettings((items[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined) ?? undefined);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const backend = resolveStorageBackend();

  if (backend !== 'chrome.storage.local') {
    throw new Error('chrome.storage.local is unavailable');
  }

  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    throw new Error('chrome.storage.local is unavailable');
  }

  await storageSet(storage, { [SETTINGS_STORAGE_KEY]: normalized });
}

export async function loadSttSettings(): Promise<SttSettingsLoadResult> {
  let backend: StorageBackendName;
  try {
    backend = resolveStorageBackend();
  } catch (e) {
    console.error('[loadSttSettings] resolveStorageBackend failed:', e);
    const settings = cloneDefaults();
    const apiKey = trimApiKey(settings.stt.apiKey);
    const provider: SttProvider = settings.stt.provider === 'openai' && apiKey ? 'openai' : 'mock';

    return {
      provider,
      ...(provider === 'openai' ? { apiKey } : {}),
      detectedFrom: provider === 'openai' ? 'settings.stt.apiKey' : 'none',
      storageArea: 'local',
      backend: 'chrome.storage.local',
    };
  }

  if (backend !== 'chrome.storage.local') {
    const settings = cloneDefaults();
    const apiKey = trimApiKey(settings.stt.apiKey);
    const provider: SttProvider = settings.stt.provider === 'openai' && apiKey ? 'openai' : 'mock';

    return {
      provider,
      ...(provider === 'openai' ? { apiKey } : {}),
      detectedFrom: provider === 'openai' ? 'settings.stt.apiKey' : 'none',
      storageArea: 'local',
      backend: 'chrome.storage.local',
    };
  }

  let settings: ExtensionSettings;
  try {
    settings = await loadSettings();
  } catch {
    settings = cloneDefaults();
  }

  const apiKey = trimApiKey(settings.stt.apiKey);
  const provider: SttProvider = settings.stt.provider === 'openai' && apiKey ? 'openai' : 'mock';

  return {
    provider,
    ...(provider === 'openai' ? { apiKey } : {}),
    detectedFrom: provider === 'openai' ? 'settings.stt.apiKey' : 'none',
    storageArea: 'local',
    backend: 'chrome.storage.local',
  };
}

export async function saveSttSettings(stt: { apiKey?: string; provider?: SttProvider }): Promise<void> {
  const settings = await loadSettings();
  const nextApiKey = trimApiKey(stt.apiKey);
  const nextStt: SttSettings =
    stt.provider === 'openai' && nextApiKey ? { provider: 'openai', apiKey: nextApiKey } : { provider: 'mock' };

  await saveSettings({
    ...settings,
    stt: nextStt,
  });
}

export async function getSttCredentialSummary(): Promise<SttCredentialSummary> {
  const stt = await loadSttSettings();
  const apiKey = trimApiKey(stt.apiKey);
  const configured = stt.provider === 'openai' && Boolean(apiKey);

  return {
    configured,
    provider: configured ? 'openai' : 'mock',
    ...(configured ? { last4: apiKey.slice(-4) } : {}),
    backend: stt.backend,
    detectedFrom: stt.detectedFrom,
  };
}
