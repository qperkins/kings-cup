/**
 * Reference client for the King's Cup WS protocol. Demonstrates the three
 * house patterns working together:
 *  - every send returns a TryCatchResult, narrowed by the caller
 *  - reconnects and retried sends use full-jitter backoff, keyed on the
 *    same action_id so server-side idempotency (engine.py) makes retries safe
 *  - one WideEvent per action sent, not scattered console.log calls
 *
 * This is intentionally framework-agnostic (no React) so it's shared
 * as-is between the Next.js web app and the React Native app.
 */
import { tryCatch, type TryCatchResult } from "./tryCatch";
import { retryWithBackoff } from "./retry";
import { WideEvent } from "./logger";

type ServerEvent = { type: string; payload: Record<string, unknown> };
type ActionIntent = { type: string; action_id: string; [key: string]: unknown };

const RESUME_TOKEN_KEY = "kings_cup_player_id";

export class GameSocketError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "GameSocketError";
  }
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();

  constructor(private roomId: string, private wsBaseUrl: string) {}

  /** Connect (or reconnect) with retry+backoff+jitter. Returns a
   * TryCatchResult so callers narrow success/failure instead of a raw throw
   * escaping connection setup. */
  async connect(): Promise<TryCatchResult<void>> {
    return retryWithBackoff(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${this.wsBaseUrl}/ws/${this.roomId}`);
          socket.onopen = () => {
            this.ws = socket;
            this.attachMessageHandler(socket);
            resolve();
          };
          socket.onerror = (err) => reject(new GameSocketError("WS connection failed", err));
        }),
      {
        maxAttempts: 6,
        baseDelayMs: 200,
        maxDelayMs: 8000,
        onRetry: (attempt, error, delayMs) =>
          console.warn(`[GameSocket] reconnect attempt ${attempt} failed, retrying in ${delayMs.toFixed(0)}ms`, error),
      }
    );
  }

  /** Send an intent. Generates a fresh action_id per *new* user action —
   * callers doing a retry of the SAME logical action should pass an
   * existing action_id back in so the server's idempotency check treats it
   * as a no-op replay rather than a duplicate. */
  async send(intent: Omit<ActionIntent, "action_id"> & { action_id?: string }): Promise<TryCatchResult<void>> {
    // Spread FIRST, then set action_id last. Reversing this order is the
    // bug to avoid: intent.action_id is `string | undefined`, so if it were
    // spread in after the computed default, an un-passed action_id would
    // silently overwrite the freshly generated UUID with `undefined` --
    // defeating idempotency for every "new action" send, not just retries.
    const fullIntent = {
      ...intent,
      action_id: intent.action_id ?? crypto.randomUUID(),
    } as ActionIntent;

    const event = new WideEvent("action_sent", {
      room_id: this.roomId,
      intent_type: fullIntent.type,
      action_id: fullIntent.action_id,
    });

    const result = await tryCatch(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new GameSocketError("Socket not open");
      }
      this.ws.send(JSON.stringify(fullIntent));
    });

    if (result.success) {
      event.emit("success");
    } else {
      // Narrow before deciding whether this is retryable-by-caller or fatal.
      if (result.error instanceof GameSocketError) {
        event.emit("error", { error_type: "GameSocketError", message: result.error.message });
      } else {
        event.emit("error", { error_type: "unknown", message: String(result.error) });
      }
    }

    return result;
  }

  on(eventType: string, handler: (payload: Record<string, unknown>) => void): void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set());
    this.listeners.get(eventType)!.add(handler);
  }

  private attachMessageHandler(socket: WebSocket): void {
    socket.onmessage = (raw) => {
      const result = tryCatchParseServerEvent(raw.data);
      if (!result.success) {
        console.error("[GameSocket] malformed server event", result.error);
        return;
      }
      const event = result.data;
      for (const handler of this.listeners.get(event.type) ?? []) handler(event.payload);
    };
  }

  /** Player identity persisted for reconnect — sent as resume_token on the
   * next join so the server rejoins the same seat instead of creating a
   * new player. See game_engine/engine.py's _handle_join. */
  static getResumeToken(): string | null {
    return typeof window !== "undefined" ? localStorage.getItem(RESUME_TOKEN_KEY) : null;
  }

  static saveResumeToken(playerId: string): void {
    if (typeof window !== "undefined") localStorage.setItem(RESUME_TOKEN_KEY, playerId);
  }
}

function tryCatchParseServerEvent(raw: string): TryCatchResult<ServerEvent> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.type !== "string") throw new Error("missing 'type' field");
    return { success: true, data: parsed as ServerEvent };
  } catch (error) {
    return { success: false, error };
  }
}
