export type DefaultSource = 'microphone' | 'tab' | 'mix';
export type SttProvider = 'mock' | 'openai' | 'deepgram' | 'siliconflow';
type StorageAreaName = 'local' | 'localStorage';
export type StorageBackendName = 'chrome.storage.local' | 'localStorage';
export type SttDetectedFrom = 'settings.stt.apiKey' | 'none';

export type SttSettings = {
  provider: SttProvider;
  apiKey?: string;
  deepgramApiKey?: string;
  siliconflowApiKey?: string;
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
  if (provider === 'siliconflow') return 'siliconflow';
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
  const siliconflowApiKey = trimApiKey(settings?.stt?.siliconflowApiKey);
  const requestedProvider = resolveSttProvider(settings?.stt?.provider);

  let provider: SttProvider;
  if (requestedProvider === 'openai' && apiKey) {
    provider = 'openai';
  } else if (requestedProvider === 'deepgram' && deepgramApiKey) {
    provider = 'deepgram';
  } else if (requestedProvider === 'siliconflow' && siliconflowApiKey) {
    provider = 'siliconflow';
  } else {
    provider = 'mock';
  }

  const optionalKeys = {
    ...(apiKey ? { apiKey } : {}),
    ...(deepgramApiKey ? { deepgramApiKey } : {}),
    ...(siliconflowApiKey ? { siliconflowApiKey } : {}),
  };

  const stt: SttSettings =
    provider === 'openai'
      ? { provider, apiKey, ...optionalKeys }
      : provider === 'deepgram'
        ? { provider, deepgramApiKey, ...optionalKeys }
        : provider === 'siliconflow'
          ? { provider, siliconflowApiKey, ...optionalKeys }
          : { provider: 'mock', ...optionalKeys };

  const ai: AiFeatureSettings = {
    summaryEnabled: settings?.ai?.summaryEnabled ?? false,
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
    return buildSttLoadResult(settings);
  }

  if (backend !== 'chrome.storage.local') {
    const settings = cloneDefaults();
    return buildSttLoadResult(settings);
  }

  let settings: ExtensionSettings;
  try {
    settings = await loadSettings();
  } catch {
    settings = cloneDefaults();
  }

  return buildSttLoadResult(settings);
}

function buildSttLoadResult(settings: ExtensionSettings): SttSettingsLoadResult {
  const apiKey = trimApiKey(settings.stt.apiKey);
  const deepgramApiKey = trimApiKey(settings.stt.deepgramApiKey);
  const siliconflowApiKey = trimApiKey(settings.stt.siliconflowApiKey);
  const provider = settings.stt.provider;

  const detectedFrom: SttDetectedFrom =
    (provider === 'openai' && apiKey) || (provider === 'deepgram' && deepgramApiKey) || (provider === 'siliconflow' && siliconflowApiKey)
      ? 'settings.stt.apiKey'
      : 'none';

  return {
    provider,
    ...(provider === 'openai' && apiKey ? { apiKey } : {}),
    ...(provider === 'deepgram' && deepgramApiKey ? { deepgramApiKey } : {}),
    ...(provider === 'siliconflow' && siliconflowApiKey ? { siliconflowApiKey } : {}),
    detectedFrom,
    storageArea: 'local',
    backend: 'chrome.storage.local',
  };
}

export async function saveSttSettings(stt: { apiKey?: string; deepgramApiKey?: string; siliconflowApiKey?: string; provider?: SttProvider }): Promise<void> {
  const settings = await loadSettings();
  const nextApiKey = trimApiKey(stt.apiKey);
  const nextDeepgramApiKey = trimApiKey(stt.deepgramApiKey);
  const nextSiliconflowApiKey = trimApiKey(stt.siliconflowApiKey);

  const nextStt: SttSettings = {
    provider: stt.provider ?? settings.stt.provider,
    ...(nextApiKey ? { apiKey: nextApiKey } : {}),
    ...(nextDeepgramApiKey ? { deepgramApiKey: nextDeepgramApiKey } : {}),
    ...(nextSiliconflowApiKey ? { siliconflowApiKey: nextSiliconflowApiKey } : {}),
  };

  await saveSettings({
    ...settings,
    stt: nextStt,
  });
}

export async function getSttCredentialSummary(): Promise<SttCredentialSummary> {
  const stt = await loadSttSettings();
  const apiKey = trimApiKey(stt.apiKey);
  const deepgramApiKey = trimApiKey(stt.deepgramApiKey);
  const siliconflowApiKey = trimApiKey(stt.siliconflowApiKey);

  const configured =
    (stt.provider === 'openai' && Boolean(apiKey)) ||
    (stt.provider === 'deepgram' && Boolean(deepgramApiKey)) ||
    (stt.provider === 'siliconflow' && Boolean(siliconflowApiKey));

  const activeKey = stt.provider === 'deepgram' ? deepgramApiKey : stt.provider === 'siliconflow' ? siliconflowApiKey : apiKey;

  return {
    configured,
    provider: configured ? stt.provider : 'mock',
    ...(configured && activeKey ? { last4: activeKey.slice(-4) } : {}),
    backend: stt.backend,
    detectedFrom: stt.detectedFrom,
  };
}
