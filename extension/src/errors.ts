/**
 * Unified error hierarchy for the ReadMe extension.
 *
 * Usage:
 *   throw new AuthError('OpenAI API key is invalid');
 *   throw new NetworkError('Unable to reach Whisper API');
 *   throw new ProviderError('deepgram', 429, 'Rate limited');
 *   throw new StorageError('IndexedDB write failed');
 *
 * In catch blocks:
 *   if (err instanceof AuthError) { ... show re-auth UI ... }
 *   if (err instanceof NetworkError) { ... show offline banner ... }
 */

export type ErrorCategory = 'auth' | 'network' | 'provider' | 'storage' | 'recording' | 'unknown';

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly recoverable: boolean;

  constructor(message: string, category: ErrorCategory, recoverable = true) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.recoverable = recoverable;
  }

  /** User-facing short label for the error category. */
  get label(): string {
    switch (this.category) {
      case 'auth':
        return 'Authentication';
      case 'network':
        return 'Network';
      case 'provider':
        return 'Provider';
      case 'storage':
        return 'Storage';
      case 'recording':
        return 'Recording';
      default:
        return 'Error';
    }
  }
}

/** Missing or invalid API key. */
export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 'auth', true);
    this.name = 'AuthError';
  }
}

/** Fetch failed, timeout, DNS, or offline. */
export class NetworkError extends AppError {
  constructor(message: string) {
    super(message, 'network', true);
    this.name = 'NetworkError';
  }
}

/** STT/LLM provider returned an error response. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly status: number;
  readonly apiMessage: string;

  constructor(provider: string, status: number, apiMessage: string) {
    super(`${provider} API error (${status}): ${apiMessage}`, 'provider', status === 429 || status >= 500);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.apiMessage = apiMessage;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/** IndexedDB or chrome.storage failures. */
export class StorageError extends AppError {
  constructor(message: string) {
    super(message, 'storage', false);
    this.name = 'StorageError';
  }
}

/** Recording pipeline failures (stream, MediaRecorder, chunk). */
export class RecordingError extends AppError {
  constructor(message: string) {
    super(message, 'recording', true);
    this.name = 'RecordingError';
  }
}

/**
 * Wrap an unknown caught value into an AppError.
 * Preserves AppError subclasses; wraps everything else as unknown category.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError(err.message, 'unknown', true);
  return new AppError(String(err), 'unknown', true);
}

/**
 * Classify a fetch error into the appropriate AppError subclass.
 * Call this in catch blocks around fetch() calls.
 */
export function classifyFetchError(err: unknown, provider: string): AppError {
  if (err instanceof AppError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('network') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ERR_INTERNET_DISCONNECTED')
  ) {
    return new NetworkError(`Unable to reach ${provider}: ${message}`);
  }

  return new AppError(message, 'unknown', true);
}
