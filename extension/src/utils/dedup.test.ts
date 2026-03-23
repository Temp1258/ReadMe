import { describe, it, expect } from 'vitest';
import { removeOverlapPrefix } from './dedup';

describe('removeOverlapPrefix', () => {
  it('returns incoming text when no overlap exists', () => {
    expect(removeOverlapPrefix('hello world foo bar baz', 'completely different text here now')).toBe('completely different text here now');
  });

  it('removes overlapping prefix when tail of existing matches head of incoming', () => {
    const existing = 'The quick brown fox jumps over the lazy dog';
    const incoming = 'jumps over the lazy dog and then runs away';
    expect(removeOverlapPrefix(existing, incoming)).toBe('and then runs away');
  });

  it('returns incoming when existing is empty', () => {
    expect(removeOverlapPrefix('', 'hello world')).toBe('hello world');
  });

  it('returns incoming when incoming is empty', () => {
    expect(removeOverlapPrefix('hello world', '')).toBe('');
  });

  it('handles case-insensitive matching', () => {
    const existing = 'The Quick Brown Fox Jumps Over';
    const incoming = 'quick brown fox jumps over and landed softly';
    expect(removeOverlapPrefix(existing, incoming)).toBe('and landed softly');
  });

  it('ignores punctuation differences when matching', () => {
    const existing = 'the end of the sentence here.';
    const incoming = 'end of the sentence here! Start of new.';
    expect(removeOverlapPrefix(existing, incoming)).toBe('Start of new.');
  });

  it('no dedup when overlap is too short (below MIN_OVERLAP_CHARS)', () => {
    const existing = 'hello world';
    const incoming = 'world next thing coming along';
    // "world" is only 5 normalized chars, below MIN_OVERLAP_CHARS (10)
    expect(removeOverlapPrefix(existing, incoming)).toBe('world next thing coming along');
  });

  it('handles large overlap', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const existing = words.join(' ');
    // Overlap of 30 words from the end
    const overlapStart = 20;
    const incoming = [...words.slice(overlapStart), 'newA', 'newB'].join(' ');
    const result = removeOverlapPrefix(existing, incoming);
    expect(result).toBe('newA newB');
  });

  it('returns empty when incoming is entirely a suffix of existing', () => {
    const existing = 'one two three four five six seven eight nine ten';
    const incoming = 'five six seven eight nine ten';
    expect(removeOverlapPrefix(existing, incoming)).toBe('');
  });

  it('deduplicates Chinese text correctly', () => {
    const existing = '山有峰顶，海有彼岸，人生漫漫，万物皆会回转，也自有回想。';
    const incoming = '万物皆会回转，也自有回想。艾克哈特托利在这本书的一开头就讲了个小故事。';
    expect(removeOverlapPrefix(existing, incoming)).toBe('艾克哈特托利在这本书的一开头就讲了个小故事。');
  });

  it('deduplicates mixed CJK and emoji text', () => {
    const existing = '这本书告诉我们，这种。🎼思维的百分之八九十不仅是重复且无用的';
    const incoming = '🎼思维的百分之八九十不仅是重复且无用的，很多时候甚至会造成伤害。';
    expect(removeOverlapPrefix(existing, incoming)).toBe('很多时候甚至会造成伤害。');
  });

  it('handles Chinese text with no overlap', () => {
    const existing = '这是第一段完全不同的话题，关于天气和季节。';
    const incoming = '这是完全不同的第二段话，讨论科学和技术的进步。';
    expect(removeOverlapPrefix(existing, incoming)).toBe('这是完全不同的第二段话，讨论科学和技术的进步。');
  });

  it('deduplicates long Chinese overlap spanning sentences', () => {
    const existing = '他发现我们之所以痛苦，很多时候并不是因为发生了什么事，而是因为我们脑袋里对那件事没完没了的想法。那么这个总是在我们脑袋里喋喋不休，制造各种麻烦和焦虑的声音究竟是什么呢？';
    const incoming = '那么这个总是在我们脑袋里喋喋不休，制造各种麻烦和焦虑的声音究竟是什么呢？他又是怎么控制我们的呢？';
    expect(removeOverlapPrefix(existing, incoming)).toBe('他又是怎么控制我们的呢？');
  });
});
