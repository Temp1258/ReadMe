export type DeepgramSettings = {
  apiKey: string;
  model?: string;
  language?: string;
};

export class DeepgramApiError extends Error {
  status: number;
  apiMessage: string;

  constructor(status: number, apiMessage: string) {
    super(`Deepgram API error (${status}): ${apiMessage}`);
    this.name = 'DeepgramApiError';
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

const DEEPGRAM_ENDPOINT = 'https://api.deepgram.com/v1/listen';

export async function transcribeWithDeepgram(
  blob: Blob,
  settings: DeepgramSettings,
): Promise<string> {
  const model = settings.model ?? 'nova-2';
  const language = settings.language ?? 'en';

  const params = new URLSearchParams({
    model,
    language,
    smart_format: 'true',
    punctuate: 'true',
  });

  const response = await fetch(`${DEEPGRAM_ENDPOINT}?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${settings.apiKey}`,
      'Content-Type': blob.type || 'audio/webm',
    },
    body: blob,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new DeepgramApiError(response.status, body || response.statusText || 'Unknown error');
  }

  const data = (await response.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
        }>;
      }>;
    };
  };

  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}
