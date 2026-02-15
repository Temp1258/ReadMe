import {
  SETTINGS_STORAGE_KEY,
  type SttDetectedFrom,
  type SttProvider,
} from './settings';

type SttBackend = 'chrome.storage.local' | 'chrome.storage.sync' | 'none';

type GetSttSettingsRequest = { type: 'GET_STT_SETTINGS' };

type GetSttSettingsSuccess = {
  ok: true;
  provider: SttProvider;
  keyPresent: boolean;
  apiKey?: string;
  last4?: string | null;
  detectedFrom?: string | null;
  backend: SttBackend;
};

type GetSttSettingsFailure = {
  ok: false;
  error: string;
  backend: 'none';
};

type LegacyItems = {
  settings?: {
    stt?: {
      provider?: unknown;
      apiKey?: unknown;
    };
  };
};

function storageGet(storage: chrome.storage.StorageArea, keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    storage.get(keys, (items) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(items as Record<string, unknown>);
    });
  });
}


function parseSttFromItems(items: Record<string, unknown>): {
  provider: SttProvider;
  keyPresent: boolean;
  apiKey: string;
  last4: string | null;
  detectedFrom: SttDetectedFrom;
} {
  const settings = ((items[SETTINGS_STORAGE_KEY] as LegacyItems['settings']) ?? {}) as LegacyItems['settings'];
  const nestedProvider = settings?.stt?.provider;
  const configuredProvider: SttProvider = nestedProvider === 'openai' || nestedProvider === 'openaiWhisper' ? 'openai' : 'mock';

  const canonicalApiKey = typeof settings?.stt?.apiKey === 'string' ? settings.stt.apiKey : '';
  const apiKey = canonicalApiKey.trim();
  const keyPresent = apiKey.length > 0;
  const detectedFrom: SttDetectedFrom = keyPresent ? 'settings.stt.apiKey' : 'none';
  const provider: SttProvider = configuredProvider;

  return {
    provider,
    keyPresent,
    apiKey,
    last4: keyPresent ? apiKey.slice(-4) : null,
    detectedFrom,
  };
}

async function resolveSttSettings(): Promise<GetSttSettingsSuccess> {
  const localArea = chrome.storage?.local;
  const syncArea = chrome.storage?.sync;

  const candidates: Array<{ area: chrome.storage.StorageArea; backend: Exclude<SttBackend, 'none'> }> = [];
  if (localArea) {
    candidates.push({ area: localArea, backend: 'chrome.storage.local' });
  }
  if (syncArea) {
    candidates.push({ area: syncArea, backend: 'chrome.storage.sync' });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      provider: 'mock',
      keyPresent: false,
      last4: null,
      detectedFrom: 'none',
      backend: 'none',
    };
  }

  let lastSuccessfulBackend: Exclude<SttBackend, 'none'> = candidates[0].backend;

  for (const candidate of candidates) {
    const items = await storageGet(candidate.area, [SETTINGS_STORAGE_KEY]);
    lastSuccessfulBackend = candidate.backend;
    const parsed = parseSttFromItems(items);

    if (parsed.provider === 'openai' || parsed.keyPresent) {
      return {
        ok: true,
        provider: parsed.provider,
        keyPresent: parsed.keyPresent,
        apiKey: parsed.provider === 'openai' && parsed.keyPresent ? parsed.apiKey : undefined,
        last4: parsed.last4,
        detectedFrom: parsed.detectedFrom,
        backend: candidate.backend,
      };
    }
  }

  return {
    ok: true,
    provider: 'mock',
    keyPresent: false,
    last4: null,
    detectedFrom: 'none',
    backend: lastSuccessfulBackend,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as GetSttSettingsRequest;

  if (!request || request.type !== 'GET_STT_SETTINGS') {
    return;
  }

  resolveSttSettings()
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unable to read STT settings';
      sendResponse({ ok: false, error: errorMessage, backend: 'none' } as GetSttSettingsFailure);
    });

  return true;
});
