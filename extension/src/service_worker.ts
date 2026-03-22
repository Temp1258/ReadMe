import { SETTINGS_STORAGE_KEY, type SttProvider } from './settings';

type GetSttSettingsRequest = { type: 'GET_STT_SETTINGS' };

type GetSttSettingsSuccess = {
  ok: true;
  provider: SttProvider;
  keyPresent: boolean;
  apiKey?: string;
  deepgramApiKey?: string;
  siliconflowApiKey?: string;
};

type GetSttSettingsFailure = {
  ok: false;
  error: string;
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

function parseSttFromItems(items: Record<string, unknown>): { provider: SttProvider; keyPresent: boolean; apiKey?: string; deepgramApiKey?: string; siliconflowApiKey?: string } {
  const settings = (items[SETTINGS_STORAGE_KEY] as { stt?: { provider?: unknown; apiKey?: unknown; deepgramApiKey?: unknown; siliconflowApiKey?: unknown } } | undefined) ?? {};
  const rawProvider = settings.stt?.provider;
  const rawApiKey = settings.stt?.apiKey;
  const rawDeepgramApiKey = settings.stt?.deepgramApiKey;
  const rawSiliconflowApiKey = settings.stt?.siliconflowApiKey;
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  const deepgramApiKey = typeof rawDeepgramApiKey === 'string' ? rawDeepgramApiKey.trim() : '';
  const siliconflowApiKey = typeof rawSiliconflowApiKey === 'string' ? rawSiliconflowApiKey.trim() : '';
  const keyPresent = apiKey.length > 0;
  const deepgramKeyPresent = deepgramApiKey.length > 0;
  const siliconflowKeyPresent = siliconflowApiKey.length > 0;

  let provider: SttProvider;
  if (rawProvider === 'openai' && keyPresent) {
    provider = 'openai';
  } else if (rawProvider === 'deepgram' && deepgramKeyPresent) {
    provider = 'deepgram';
  } else if (rawProvider === 'siliconflow' && siliconflowKeyPresent) {
    provider = 'siliconflow';
  } else {
    provider = 'mock';
  }

  return {
    provider,
    keyPresent: provider === 'openai' ? keyPresent : provider === 'deepgram' ? deepgramKeyPresent : provider === 'siliconflow' ? siliconflowKeyPresent : false,
    ...(provider === 'openai' ? { apiKey } : {}),
    ...(provider === 'deepgram' ? { deepgramApiKey } : {}),
    ...(provider === 'siliconflow' ? { siliconflowApiKey } : {}),
  };
}

async function resolveSttSettings(): Promise<GetSttSettingsSuccess> {
  const localArea = chrome.storage?.local;
  if (!localArea) {
    return {
      ok: true,
      provider: 'mock',
      keyPresent: false,
    };
  }

  const items = await storageGet(localArea, [SETTINGS_STORAGE_KEY]);
  const parsed = parseSttFromItems(items);

  return {
    ok: true,
    provider: parsed.provider,
    keyPresent: parsed.keyPresent,
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.deepgramApiKey ? { deepgramApiKey: parsed.deepgramApiKey } : {}),
    ...(parsed.siliconflowApiKey ? { siliconflowApiKey: parsed.siliconflowApiKey } : {}),
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
      sendResponse({ ok: false, error: errorMessage } as GetSttSettingsFailure);
    });

  return true;
});
