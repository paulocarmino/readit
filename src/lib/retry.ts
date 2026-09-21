/**
 * Retry utilities for plugins
 *
 * Provides reusable retry logic with exponential backoff and jitter.
 * Can be used by any plugin that needs reliable network operations.
 */

/**
 * Options for retry operations
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Return false to stop retrying on a given error (default: always retry) */
  shouldRetry?: (error: Error) => boolean;
  /** Called before waiting for the next attempt (for logging) */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

/**
 * Calculates delay with exponential backoff and jitter
 *
 * Uses the formula: min(baseDelay * 2^attempt * jitter, maxDelay)
 * where jitter is a random value between 0.5 and 1.0 to prevent thundering herd.
 *
 * @param attempt - Attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds
 * @param maxDelay - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 *
 * @example
 * calculateDelay(0, 1000, 30000) // ~500-1000ms
 * calculateDelay(1, 1000, 30000) // ~1000-2000ms
 * calculateDelay(2, 1000, 30000) // ~2000-4000ms
 */
export function calculateDelay(attempt: number, baseDelay = 1000, maxDelay = 30000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.5 + 0.5; // 0.5 to 1.0
  return Math.round(Math.min(exponentialDelay * jitter, maxDelay));
}

/**
 * Checks if an HTTP status code indicates a retryable error
 *
 * Retryable errors:
 * - 5xx server errors (temporary server issues)
 * - 429 Too Many Requests (rate limiting)
 * - 408 Request Timeout
 * - 0 (network error / no response)
 *
 * @param status - HTTP status code
 * @returns true if the error is retryable
 *
 * @example
 * isRetryableError(500) // true - server error
 * isRetryableError(429) // true - rate limited
 * isRetryableError(404) // false - not found (client error)
 * isRetryableError(401) // false - unauthorized (client error)
 */
export function isRetryableError(status: number): boolean {
  // 5xx server errors
  if (status >= 500 && status < 600) return true;
  // 429 rate limit
  if (status === 429) return true;
  // 408 request timeout
  if (status === 408) return true;
  // Network errors (status 0)
  if (status === 0) return true;
  return false;
}

/**
 * Executes a function with automatic retry on failure
 *
 * Implements exponential backoff with jitter to handle transient failures.
 * Useful for network operations, API calls, and other potentially flaky operations.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws The last error if all attempts fail
 *
 * @example
 * // Simple usage
 * const result = await withRetry(() => fetch('https://api.example.com/data'));
 *
 * // With custom options
 * const result = await withRetry(
 *   () => uploadFile(buffer),
 *   { maxAttempts: 5, baseDelay: 500, maxDelay: 10000 }
 * );
 *
 * // With typed result
 * const user = await withRetry<User>(async () => {
 *   const res = await fetch('/api/user');
 *   return res.json();
 * });
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000, maxDelay = 30000, shouldRetry, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last attempt (or the error is not retryable), don't wait
      if (attempt === maxAttempts - 1 || (shouldRetry && !shouldRetry(lastError))) {
        break;
      }

      // Wait before next attempt
      const delay = calculateDelay(attempt, baseDelay, maxDelay);
      onRetry?.(lastError, attempt + 1, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error('All retry attempts failed');
}
