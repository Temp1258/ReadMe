import { getSttProvider } from '../settings';
import { aliyunProvider } from './aliyun';
import { openaiWhisperProvider } from './openaiWhisper';
import { tencentProvider } from './tencent';
import type { SttProvider } from './types';

export async function getActiveProvider(): Promise<SttProvider> {
  const providerId = await getSttProvider();

  if (providerId === 'aliyun') {
    return aliyunProvider;
  }

  if (providerId === 'tencent') {
    return tencentProvider;
  }

  return openaiWhisperProvider;
}
