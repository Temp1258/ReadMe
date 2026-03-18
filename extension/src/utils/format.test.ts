import { describe, it, expect } from 'vitest';
import {
  formatTimestamp,
  formatDuration,
  formatFileTimestamp,
  formatExportDuration,
  formatOffsetLabel,
  normalizeAudioSource,
  isRecordingActiveStatus,
} from './format';

describe('formatDuration', () => {
  it('returns null when endedAt is missing', () => {
    expect(formatDuration(1000)).toBeNull();
  });

  it('returns null when endedAt <= startedAt', () => {
    expect(formatDuration(1000, 500)).toBeNull();
    expect(formatDuration(1000, 1000)).toBeNull();
  });

  it('formats minutes and seconds correctly', () => {
    expect(formatDuration(0, 65000)).toBe('1m 05s');
    expect(formatDuration(0, 3600000)).toBe('60m 00s');
    expect(formatDuration(0, 125000)).toBe('2m 05s');
  });
});

describe('formatOffsetLabel', () => {
  it('formats zero offset', () => {
    expect(formatOffsetLabel(0)).toBe('00:00');
  });

  it('formats offset correctly', () => {
    expect(formatOffsetLabel(65000)).toBe('01:05');
    expect(formatOffsetLabel(3600000)).toBe('60:00');
  });

  it('handles negative offset', () => {
    expect(formatOffsetLabel(-1000)).toBe('00:00');
  });
});

describe('normalizeAudioSource', () => {
  it('returns mic for undefined', () => {
    expect(normalizeAudioSource()).toBe('mic');
  });

  it('returns mic for unknown values', () => {
    expect(normalizeAudioSource('unknown')).toBe('mic');
    expect(normalizeAudioSource('')).toBe('mic');
  });

  it('preserves valid sources', () => {
    expect(normalizeAudioSource('tab')).toBe('tab');
    expect(normalizeAudioSource('mix')).toBe('mix');
    expect(normalizeAudioSource('mic')).toBe('mic');
  });
});

describe('isRecordingActiveStatus', () => {
  it('returns false for idle/stopped/error', () => {
    expect(isRecordingActiveStatus('Idle')).toBe(false);
    expect(isRecordingActiveStatus('Stopped')).toBe(false);
    expect(isRecordingActiveStatus('Error')).toBe(false);
  });

  it('returns true for active states', () => {
    expect(isRecordingActiveStatus('Listening')).toBe(true);
    expect(isRecordingActiveStatus('Transcribing')).toBe(true);
  });
});

describe('formatFileTimestamp', () => {
  it('formats timestamp as YYYYMMDD-HHmmss', () => {
    const ts = new Date(2026, 2, 17, 14, 30, 45).getTime();
    expect(formatFileTimestamp(ts)).toBe('20260317-143045');
  });
});

describe('formatExportDuration', () => {
  it('returns in-progress when no end time', () => {
    expect(formatExportDuration(1000)).toBe('in-progress');
  });

  it('formats duration with milliseconds', () => {
    const result = formatExportDuration(0, 65000);
    expect(result).toBe('1m 05s (65000ms)');
  });
});

describe('formatTimestamp', () => {
  it('returns a locale string', () => {
    const result = formatTimestamp(0);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
