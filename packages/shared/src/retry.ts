/**
 * Same full-jitter backoff pattern as the backend's game_engine/retry.py,
 * per the AWS Builders' Library guidance (timeouts, retries, and backoff
 * with jitter): random delay in [0, min(cap, base * 2^attempt)) each
 * attempt, not a fixed interval and not plain exponential — otherwise
 * every client reconnecting after a server restart retries in lockstep
 * and re-floods it on the same tick.
 *
 * Used for: WS reconnect attempts, and retrying a send whose action_id
 * makes the retry safe (server-side idempotency in engine.py dedupes it).
 */
import { tryCatch, type TryCatchResult } from "./tryCatch";

export class RetriesExhaustedError extends Error {
  constructor(public attempts: number, public lastError: unknown) {
    super(`Gave up after ${attempts} attempts`);
    this.name = "RetriesExhaustedError";
  }
}

export interface BackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const fullJitterDelay = (attempt: number, baseDelayMs: number, maxDelayMs: number) =>
  Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns a TryCatchResult, not a thrown value — a caller who exhausts
 * retries gets { success: false, error: RetriesExhaustedError } and
 * narrows it like any other failure, rather than a raw throw escaping
 * the retry boundary.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  {
    maxAttempts = 5,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    onRetry,
  }: BackoffOptions = {}
): Promise<TryCatchResult<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await tryCatch(operation);
    if (result.success) return result;

    lastError = result.error;
    if (attempt === maxAttempts) break;

    const delayMs = fullJitterDelay(attempt, baseDelayMs, maxDelayMs);
    onRetry?.(attempt, result.error, delayMs);
    await sleep(delayMs);
  }

  return { success: false, error: new RetriesExhaustedError(maxAttempts, lastError) };
}
