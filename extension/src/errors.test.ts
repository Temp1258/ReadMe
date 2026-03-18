import { describe, it, expect } from 'vitest';
import { AppError, AuthError, NetworkError, ProviderError, StorageError, RecordingError, toAppError, classifyFetchError } from './errors';

describe('Error hierarchy', () => {
  it('AppError has correct category and label', () => {
    const err = new AppError('test', 'unknown');
    expect(err.category).toBe('unknown');
    expect(err.label).toBe('Error');
    expect(err.recoverable).toBe(true);
    expect(err.message).toBe('test');
  });

  it('AuthError has auth category', () => {
    const err = new AuthError('bad key');
    expect(err.category).toBe('auth');
    expect(err.label).toBe('Authentication');
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof AuthError).toBe(true);
  });

  it('NetworkError has network category', () => {
    const err = new NetworkError('offline');
    expect(err.category).toBe('network');
    expect(err.label).toBe('Network');
  });

  it('ProviderError captures status and provider', () => {
    const err = new ProviderError('openai', 429, 'rate limited');
    expect(err.category).toBe('provider');
    expect(err.provider).toBe('openai');
    expect(err.status).toBe(429);
    expect(err.isRateLimit).toBe(true);
    expect(err.isServerError).toBe(false);
    expect(err.recoverable).toBe(true);
  });

  it('ProviderError with 500 is server error', () => {
    const err = new ProviderError('deepgram', 503, 'unavailable');
    expect(err.isServerError).toBe(true);
    expect(err.recoverable).toBe(true);
  });

  it('ProviderError with 400 is not recoverable', () => {
    const err = new ProviderError('openai', 400, 'bad request');
    expect(err.recoverable).toBe(false);
  });

  it('StorageError is not recoverable', () => {
    const err = new StorageError('db failed');
    expect(err.category).toBe('storage');
    expect(err.recoverable).toBe(false);
  });

  it('RecordingError is recoverable', () => {
    const err = new RecordingError('mic failed');
    expect(err.category).toBe('recording');
    expect(err.recoverable).toBe(true);
  });
});

describe('toAppError', () => {
  it('passes through existing AppError', () => {
    const err = new AuthError('test');
    expect(toAppError(err)).toBe(err);
  });

  it('wraps standard Error', () => {
    const err = new Error('oops');
    const wrapped = toAppError(err);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.message).toBe('oops');
    expect(wrapped.category).toBe('unknown');
  });

  it('wraps string', () => {
    const wrapped = toAppError('string error');
    expect(wrapped.message).toBe('string error');
  });
});

describe('classifyFetchError', () => {
  it('classifies network errors', () => {
    const err = new TypeError('Failed to fetch');
    const classified = classifyFetchError(err, 'openai');
    expect(classified).toBeInstanceOf(NetworkError);
    expect(classified.message).toContain('openai');
  });

  it('passes through existing AppError', () => {
    const original = new AuthError('bad');
    expect(classifyFetchError(original, 'test')).toBe(original);
  });

  it('wraps unknown errors', () => {
    const err = new Error('something else');
    const classified = classifyFetchError(err, 'test');
    expect(classified).toBeInstanceOf(AppError);
    expect(classified.category).toBe('unknown');
  });
});
