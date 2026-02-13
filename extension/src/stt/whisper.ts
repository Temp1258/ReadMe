export type WhisperSettings = {
  apiKey: string;
  model: string;
  endpoint?: string;
  fileName?: string;
  maxRetries?: number;
};

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('webm')) {
    return 'webm';
  }

  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  if (mimeType.includes('mpeg')) {
    return 'mp3';
  }

  return 'dat';
}

async function callWhisper(blob: Blob, settings: WhisperSettings): Promise<string> {
  const endpoint = settings.endpoint ?? DEFAULT_ENDPOINT;
  const extension = extensionForMimeType(blob.type || 'audio/webm');
  const fileName = settings.fileName ?? `audio.${extension}`;
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', settings.model);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${body || response.statusText}`);
  }

  const data = (await response.json()) as { text?: string };
  return data.text?.trim() ?? '';
}

export async function transcribeAudioBlob(blob: Blob, settings: WhisperSettings): Promise<string> {
  const maxRetries = settings.maxRetries ?? 3;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await callWhisper(blob, settings);
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      const backoffMs = 400 * 2 ** (attempt - 1);
      await wait(backoffMs);
    }
  }

  return '';
}
