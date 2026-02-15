import { loadSttSettings } from '../settings';
import { transcribeAudioBlob } from '../stt/whisper';
import type { SttProvider } from './types';

function getChunkFilename(mimeType: string): string {
  const normalizedMimeType = mimeType.toLowerCase();

  if (normalizedMimeType.includes('webm')) {
    return 'chunk-1.webm';
  }

  if (normalizedMimeType.includes('wav')) {
    return 'chunk-1.wav';
  }

  if (normalizedMimeType.includes('mp4') || normalizedMimeType.includes('m4a')) {
    return 'chunk-1.m4a';
  }

  return 'chunk-1.webm';
}

export const openaiWhisperProvider: SttProvider = {
  id: 'openai',
  async transcribe(audio: Blob): Promise<{ text: string; raw?: any }> {
    // Keep key-loading behavior exactly aligned with existing settings flow.
    const stt = await loadSttSettings();
    const apiKey = stt.apiKey?.trim() ?? '';

    if (!apiKey) {
      throw new Error('OpenAI STT failed: Whisper API key is missing');
    }

    const text = await transcribeAudioBlob(audio, {
      apiKey,
      model: 'whisper-1',
      fileName: getChunkFilename(audio.type || ''),
      maxRetries: 1,
    });

    return { text: text.trim() };
  },
};
