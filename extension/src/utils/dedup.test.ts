import { describe, it, expect } from 'vitest';
import { removeOverlapPrefix } from './dedup';

describe('removeOverlapPrefix', () => {
  it('returns incoming text when no overlap exists', () => {
    expect(removeOverlapPrefix('hello world', 'foo bar baz')).toBe('foo bar baz');
  });

  it('removes overlapping prefix when tail of existing matches head of incoming', () => {
    const existing = 'The quick brown fox jumps over the lazy dog';
    const incoming = 'over the lazy dog and then runs away';
    expect(removeOverlapPrefix(existing, incoming)).toBe('and then runs away');
  });

  it('handles exact match of minimum overlap (3 words)', () => {
    expect(removeOverlapPrefix('a b c d e', 'c d e new text here')).toBe('new text here');
  });

  it('returns incoming when existing is empty', () => {
    expect(removeOverlapPrefix('', 'hello world')).toBe('hello world');
  });

  it('returns incoming when incoming is empty', () => {
    expect(removeOverlapPrefix('hello world', '')).toBe('');
  });

  it('handles case-insensitive matching', () => {
    const existing = 'The Quick Brown Fox';
    const incoming = 'quick brown fox jumped high';
    expect(removeOverlapPrefix(existing, incoming)).toBe('jumped high');
  });

  it('strips punctuation for matching but preserves original words', () => {
    const existing = 'the end of sentence.';
    const incoming = 'end of sentence. Start of new.';
    expect(removeOverlapPrefix(existing, incoming)).toBe('Start of new.');
  });

  it('handles overlap shorter than minimum (2 words) - no dedup', () => {
    const existing = 'hello world';
    const incoming = 'world next thing coming';
    // 1-word overlap is below MIN_OVERLAP_DEDUP_WORDS (3), so no dedup
    expect(removeOverlapPrefix(existing, incoming)).toBe('world next thing coming');
  });

  it('handles large overlap up to max', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const existing = words.join(' ');
    // Overlap of 30 words from the end
    const overlapStart = 20;
    const incoming = [...words.slice(overlapStart), 'newA', 'newB'].join(' ');
    const result = removeOverlapPrefix(existing, incoming);
    expect(result).toBe('newA newB');
  });

  it('returns empty when incoming is entirely a suffix of existing', () => {
    const existing = 'one two three four five six seven';
    const incoming = 'five six seven';
    expect(removeOverlapPrefix(existing, incoming)).toBe('');
  });
});
