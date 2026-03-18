import { describe, it, expect } from 'vitest';
import { buildTxtExport, buildMarkdownExport, buildSrtExport } from './export';
import type { SessionRecord } from '../db/indexeddb';

const mockSession: SessionRecord = {
  id: 'test-session-1',
  startedAt: 1710000000000,
  endedAt: 1710000065000,
  source: 'mic',
  status: 'stopped',
  transcript: 'Hello world, this is a test transcript.',
  segments: [
    { idx: 1, ts: 1710000030000, text: 'Hello world', startOffsetMs: 0, endOffsetMs: 30000 },
    { idx: 2, ts: 1710000060000, text: 'this is a test transcript.', startOffsetMs: 30000, endOffsetMs: 60000 },
  ],
};

const emptySession: SessionRecord = {
  id: 'test-session-2',
  startedAt: 1710000000000,
  source: 'tab',
  status: 'idle',
  transcript: '',
  segments: [],
};

describe('buildTxtExport', () => {
  it('includes metadata section', () => {
    const result = buildTxtExport(mockSession);
    expect(result).toContain('Session Metadata');
    expect(result).toContain('id: test-session-1');
    expect(result).toContain('source: mic');
    expect(result).toContain('status: stopped');
  });

  it('includes transcript section', () => {
    const result = buildTxtExport(mockSession);
    expect(result).toContain('Transcript');
    expect(result).toContain('Hello world, this is a test transcript.');
  });

  it('includes segments with timing', () => {
    const result = buildTxtExport(mockSession);
    expect(result).toContain('[Segment 1 |');
    expect(result).toContain('[Segment 2 |');
    expect(result).toContain('Hello world');
  });

  it('handles empty session', () => {
    const result = buildTxtExport(emptySession);
    expect(result).toContain('(empty)');
    expect(result).toContain('(none)');
  });
});

describe('buildMarkdownExport', () => {
  it('includes markdown headers', () => {
    const result = buildMarkdownExport(mockSession);
    expect(result).toContain('# ReadMe Session Export');
    expect(result).toContain('## Metadata');
    expect(result).toContain('## Transcript');
    expect(result).toContain('## Segments');
  });

  it('wraps transcript in code block', () => {
    const result = buildMarkdownExport(mockSession);
    expect(result).toContain('```text');
    expect(result).toContain('Hello world, this is a test transcript.');
    expect(result).toContain('```');
  });

  it('uses bullet points for metadata', () => {
    const result = buildMarkdownExport(mockSession);
    expect(result).toContain('- id: test-session-1');
    expect(result).toContain('- source: mic');
  });
});

describe('buildSrtExport', () => {
  it('produces valid SRT format with timing', () => {
    const result = buildSrtExport(mockSession);
    expect(result).toContain('1\n00:00:00,000 --> 00:00:30,000\nHello world');
    expect(result).toContain('2\n00:00:30,000 --> 00:01:00,000\nthis is a test transcript.');
  });

  it('returns empty string for session with no segments', () => {
    expect(buildSrtExport(emptySession)).toBe('');
  });

  it('skips segments without timing', () => {
    const session: SessionRecord = {
      ...mockSession,
      segments: [
        { idx: 1, ts: 100, text: 'no timing' },
        { idx: 2, ts: 200, text: 'has timing', startOffsetMs: 5000, endOffsetMs: 10000 },
      ],
    };
    const result = buildSrtExport(session);
    expect(result).not.toContain('no timing');
    expect(result).toContain('1\n00:00:05,000 --> 00:00:10,000\nhas timing');
  });

  it('formats hours correctly for long recordings', () => {
    const session: SessionRecord = {
      ...mockSession,
      segments: [
        { idx: 1, ts: 100, text: 'hour mark', startOffsetMs: 3661500, endOffsetMs: 3665000 },
      ],
    };
    const result = buildSrtExport(session);
    expect(result).toContain('01:01:01,500 --> 01:01:05,000');
  });
});
