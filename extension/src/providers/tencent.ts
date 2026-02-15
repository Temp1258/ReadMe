import { getTencentCreds } from '../settings';
import type { SttProvider } from './types';

const TENCENT_HOST = 'asr.tencentcloudapi.com';
const TENCENT_ENDPOINT = `https://${TENCENT_HOST}`;
const TENCENT_SERVICE = 'asr';
const TENCENT_ACTION = 'SentenceRecognition';
const TENCENT_VERSION = '2019-06-14';
const ALGORITHM = 'TC3-HMAC-SHA256';

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(digest);
}

async function hmacSha256(key: Uint8Array | string, message: string): Promise<ArrayBuffer> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const normalizedKey = new Uint8Array(keyBytes.byteLength);
  normalizedKey.set(keyBytes);
  const cryptoKey = await crypto.subtle.importKey('raw', normalizedKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function deriveSigningKey(secretKey: string, date: string): Promise<Uint8Array> {
  const kDate = new Uint8Array(await hmacSha256(`TC3${secretKey}`, date));
  const kService = new Uint8Array(await hmacSha256(kDate, TENCENT_SERVICE));
  const kSigning = new Uint8Array(await hmacSha256(kService, 'tc3_request'));
  return kSigning;
}

function getDateString(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function getVoiceFormat(mimeType: string): 'wav' | 'mp3' | 'webm' {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('wav')) {
    return 'wav';
  }
  if (normalized.includes('mpeg') || normalized.includes('mp3')) {
    return 'mp3';
  }
  return 'webm';
}

function getTencentErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const response = (payload as { Response?: { Error?: { Message?: string } } }).Response;
  return response?.Error?.Message?.trim() || fallback;
}

export const tencentProvider: SttProvider = {
  id: 'tencent',
  async transcribe(audio: Blob): Promise<{ text: string; raw?: any }> {
    const { secretId, secretKey, region } = await getTencentCreds();
    if (!secretId || !secretKey) {
      throw new Error('Tencent STT failed: credentials are missing');
    }

    const audioBytes = new Uint8Array(await audio.arrayBuffer());
    const payload = {
      ProjectId: 0,
      SubServiceType: 2,
      EngSerViceType: '16k_zh',
      SourceType: 1,
      VoiceFormat: getVoiceFormat(audio.type || ''),
      UsrAudioKey: crypto.randomUUID(),
      Data: toBase64(audioBytes),
      DataLen: audioBytes.byteLength,
    };

    const payloadString = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = getDateString(timestamp);

    const canonicalHeaders =
      `content-type:application/json; charset=utf-8\n` +
      `host:${TENCENT_HOST}\n` +
      `x-tc-action:${TENCENT_ACTION.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest =
      `POST\n` +
      `/\n` +
      `\n` +
      canonicalHeaders +
      `\n` +
      signedHeaders +
      `\n` +
      (await sha256Hex(payloadString));

    const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
    const stringToSign = `${ALGORITHM}\n${timestamp}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
    const signingKey = await deriveSigningKey(secretKey, date);
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const authorization = `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(TENCENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: TENCENT_HOST,
        'X-TC-Action': TENCENT_ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': TENCENT_VERSION,
        'X-TC-Region': region,
        Authorization: authorization,
      },
      body: payloadString,
    });

    const data = (await response.json()) as Record<string, unknown>;
    const responsePayload = data.Response as { Result?: string; Error?: { Message?: string } } | undefined;

    if (!response.ok || responsePayload?.Error) {
      throw new Error(`Tencent STT failed: ${getTencentErrorMessage(data, response.statusText || 'Unknown error')}`);
    }

    return { text: (typeof responsePayload?.Result === 'string' ? responsePayload.Result : '').trim(), raw: data };
  },
};
