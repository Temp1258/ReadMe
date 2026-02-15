import { getAliyunCreds } from '../settings';
import type { SttProvider } from './types';

const ALIYUN_ENDPOINT = 'https://nls-gateway.cn-shanghai.aliyuncs.com/stream/v1/asr';

function getAliyunErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const asRecord = payload as Record<string, unknown>;
  const message = asRecord.message ?? asRecord.Message ?? asRecord.msg;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

export const aliyunProvider: SttProvider = {
  id: 'aliyun',
  async transcribe(audio: Blob): Promise<{ text: string; raw?: any }> {
    const { appKey, token } = await getAliyunCreds();
    if (!appKey || !token) {
      throw new Error('Aliyun STT failed: credentials are missing');
    }

    const params = new URLSearchParams({
      appkey: appKey,
      format: 'wav',
      sample_rate: '16000',
      enable_punctuation_prediction: 'true',
      enable_inverse_text_normalization: 'true',
    });

    const response = await fetch(`${ALIYUN_ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'X-NLS-Token': token,
      },
      body: await audio.arrayBuffer(),
    });

    const bodyText = await response.text();
    let parsed: Record<string, unknown> | null = null;

    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      throw new Error(`Aliyun STT failed: ${getAliyunErrorMessage(parsed, bodyText || response.statusText || 'Unknown error')}`);
    }

    const text =
      (typeof parsed?.result === 'string' ? parsed.result : '') ||
      (typeof parsed?.text === 'string' ? parsed.text : '') ||
      (typeof parsed?.sentence === 'string' ? parsed.sentence : '');

    return { text: text.trim(), raw: parsed ?? bodyText };
  },
};
