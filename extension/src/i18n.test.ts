import { describe, it, expect } from 'vitest';
import { createTranslator, UI_COPY } from './i18n';

describe('createTranslator', () => {
  it('returns English translations by default', () => {
    const t = createTranslator('en');
    expect(t('appTitle')).toBe('ReadMe');
    expect(t('start')).toBe('Start');
    expect(t('stop')).toBe('Stop');
  });

  it('returns Chinese translations when lang is zh', () => {
    const t = createTranslator('zh');
    expect(t('appTitle')).toBe('ReadMe');
    expect(t('start')).toBe('开始');
    expect(t('stop')).toBe('停止');
  });

  it('has matching keys for en and zh', () => {
    const enKeys = Object.keys(UI_COPY.en).sort();
    const zhKeys = Object.keys(UI_COPY.zh).sort();
    expect(enKeys).toEqual(zhKeys);
  });
});
