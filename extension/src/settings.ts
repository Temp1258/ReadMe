export type DefaultSource = 'microphone' | 'tab' | 'mix';
export type SttProvider = 'mock' | 'openai';
export type StorageAreaName = 'local' | 'localStorage' | 'none';
export type StorageBackendName = 'chrome.storage.local' | 'localStorage';
export type SttDetectedFrom = 'settings.stt.apiKey' | 'none';

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

export type SttCredentialSummary = {
  configured: boolean;
  provider: SttProvider;
  last4?: string;
  backend: StorageBackendName;
  detectedFrom: SttDetectedFrom;
};

export const SETTINGS_STORAGE_KEY = 'settings';

function resolveSttProvider(provider: unknown): SttProvider {
  return provider === 'openai' ? 'openai' : 'mock';
}

function trimApiKey(apiKey: unknown): string {
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

function normalizeSettings(settings: Partial<ExtensionSettings> | null | undefined): ExtensionSettings {
  const defaultSource: DefaultSource =
    settings?.defaultSource === 'tab' || settings?.defaultSource === 'mix' ? settings.defaultSource : 'microphone';

  const apiKey = trimApiKey(settings?.stt?.apiKey);
  const requestedProvider = resolveSttProvider(settings?.stt?.provider);
  const provider: SttProvider = requestedProvider === 'openai' && apiKey ? 'openai' : 'mock';

  return {
    defaultSource,
    stt: provider === 'openai' ? { provider, apiKey } : { provider: 'mock' },
  };
}

export const defaults: ExtensionSettings = normalizeSettings(undefined);

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) {
    return '';
  }

  return `****${trimmed.slice(-4)}`;
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
  const backend = resolveStorageBackend();

  if (backend === 'chrome.storage.local') {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) {
      return cloneDefaults();
    }

    const items = await storageGet(storage, [SETTINGS_STORAGE_KEY]);
    return normalizeSettings((items[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined) ?? undefined);
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return cloneDefaults();
  }

  try {
    return normalizeSettings(JSON.parse(raw) as Partial<ExtensionSettings>);
  } catch {
    return cloneDefaults();
  }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const backend = resolveStorageBackend();

  if (backend === 'chrome.storage.local') {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) {
      return;
    }

    await storageSet(storage, { [SETTINGS_STORAGE_KEY]: normalized });
    return;
  }

  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
}

export async function loadSttSettings(): Promise<SttSettingsLoadResult> {
  const settings = await loadSettings();
  const apiKey = trimApiKey(settings.stt.apiKey);
  const provider: SttProvider = settings.stt.provider === 'openai' && apiKey ? 'openai' : 'mock';

  return {
    provider,
    ...(provider === 'openai' ? { apiKey } : {}),
    detectedFrom: provider === 'openai' ? 'settings.stt.apiKey' : 'none',
    storageArea: resolveStorageBackend() === 'chrome.storage.local' ? 'local' : 'localStorage',
    backend: resolveStorageBackend(),
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
