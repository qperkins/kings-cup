import {
  GameSocket,
  RetriesExhaustedError,
  retryWithBackoff,
  WideEvent,
  type BackoffOptions,
  type TryCatchResult,
} from "@kings-cup/shared";

/** Allowlist — only known transient server rejections trigger client resend. */
const RETRYABLE_ERROR_DETAILS = new Set(["Room busy, please retry"]);

// TODO: Revisit once real measured p99 duration_ms is available from wide events —
// must exceed stacked lock+load+save+publish retry latency, not treated as final.
export const SERVER_VERDICT_TIMEOUT_MS = 12_000;

export type ServerVerdict =
  | { kind: "ok" }
  | { kind: "retryable"; detail: string }
  | { kind: "fatal"; detail: string }
  | { kind: "aborted" };

export type PendingVerdict = {
  resolve: (verdict: ServerVerdict) => void;
  cancel: () => void;
};

export function isRetryableServerError(detail: string): boolean {
  return RETRYABLE_ERROR_DETAILS.has(detail);
}

export function parseServerErrorDetail(detail: string): ServerVerdict {
  if (isRetryableServerError(detail)) {
    return { kind: "retryable", detail };
  }
  return { kind: "fatal", detail };
}

class RetryableSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSendError";
  }
}

type ActionIntentBody = {
  type: string;
  [key: string]: unknown;
};

/**
 * Send an intent with client-side retry on lock contention. Pins action_id
 * before the loop so server idempotency treats resends as replays.
 */
export async function sendIntentWithRetry(
  socket: GameSocket,
  intent: ActionIntentBody,
  waitForVerdict: () => Promise<ServerVerdict>,
  options: BackoffOptions = {},
): Promise<TryCatchResult<void>> {
  const actionId = crypto.randomUUID();
  let fatalDetail: string | null = null;
  let aborted = false;

  const event = new WideEvent("intent_with_retry", {
    intent_type: intent.type,
    action_id: actionId,
  });

  const result = await retryWithBackoff(
    async () => {
      if (fatalDetail) return;

      const sendResult = await socket.send({ ...intent, action_id: actionId });
      if (!sendResult.success) {
        throw new RetryableSendError("transport send failed");
      }

      const verdict = await waitForVerdict();

      if (verdict.kind === "fatal") {
        fatalDetail = verdict.detail;
        return;
      }
      if (verdict.kind === "aborted") {
        aborted = true;
        return;
      }
      if (verdict.kind === "retryable") {
        throw new RetryableSendError(verdict.detail);
      }
    },
    {
      maxAttempts: 5,
      baseDelayMs: 200,
      maxDelayMs: 8000,
      ...options,
      onRetry: (attempt, error, delayMs) => {
        options.onRetry?.(attempt, error, delayMs);
        event.merge({ last_retry_attempt: attempt, last_retry_delay_ms: delayMs });
      },
    },
  );

  if (aborted) {
    event.emit("error", { detail: "aborted" });
    return { success: false, error: "Disconnected" };
  }

  if (fatalDetail) {
    event.emit("error", { detail: fatalDetail, rejected: true });
    return { success: false, error: fatalDetail };
  }

  if (!result.success) {
    const message =
      result.error instanceof RetriesExhaustedError
        ? "Room busy, please retry"
        : "Failed to send action";
    event.emit("error", {
      detail: message,
      error_type:
        result.error instanceof RetriesExhaustedError
          ? "RetriesExhaustedError"
          : "unknown",
    });
    return { success: false, error: message };
  }

  event.emit("success");
  return { success: true, data: undefined };
}

/** Build a per-send verdict waiter backed by the socket error handler.
 * Single slot per hook — not keyed by action_id (server error events carry
 * no action_id). Safe because each tab serializes one in-flight send. */
export function createVerdictWaiter(
  getPending: () => PendingVerdict | null,
  setPending: (pending: PendingVerdict | null) => void,
): () => Promise<ServerVerdict> {
  return () =>
    new Promise((resolve) => {
      let settled = false;

      const finish = (verdict: ServerVerdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setPending(null);
        resolve(verdict);
      };

      const timer = setTimeout(() => finish({ kind: "ok" }), SERVER_VERDICT_TIMEOUT_MS);

      // Cancel any previous waiter (e.g. retry starting a new attempt).
      getPending()?.cancel();

      setPending({
        resolve: finish,
        cancel: () => finish({ kind: "aborted" }),
      });
    });
}

/** Route an error event to the active verdict waiter. Returns true if consumed. */
export function deliverErrorToPendingVerdict(
  getPending: () => PendingVerdict | null,
  detail: string,
): boolean {
  const pending = getPending();
  if (!pending) return false;
  pending.resolve(parseServerErrorDetail(detail));
  return true;
}

/** Clear timer and resolve an in-flight waiter immediately (disconnect/unmount). */
export function cancelPendingVerdict(
  getPending: () => PendingVerdict | null,
): void {
  getPending()?.cancel();
}
