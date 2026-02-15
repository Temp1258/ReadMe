export type SttProviderId = 'openai' | 'aliyun' | 'tencent';

export interface SttProvider {
  id: SttProviderId;
  transcribe(audio: Blob): Promise<{ text: string; raw?: any }>;
}
