/**
 * Client-side counterpart to the backend's WideEvent (game_engine/logging_utils.py):
 * one structured event per unit of work — here, per client action sent —
 * instead of scattered console.log calls at each step. Same field, same
 * name (`action_id`), on both sides of the WS connection means a single
 * search across client + server logs by action_id reconstructs the whole
 * round trip.
 */

type EventFields = Record<string, unknown>;

export class WideEvent {
  private fields: EventFields;
  private start: number;

  constructor(eventName: string, initial: EventFields = {}) {
    this.start = performance.now();
    this.fields = { event: eventName, ...initial };
  }

  set(key: string, value: unknown): void {
    this.fields[key] = value;
  }

  merge(fields: EventFields): void {
    Object.assign(this.fields, fields);
  }

  /** Call exactly once, when the unit of work (e.g. the action's
   * server response, or its terminal error) is fully resolved. */
  emit(outcome: "success" | "error" | "timeout", extra: EventFields = {}): void {
    this.fields.duration_ms = Math.round(performance.now() - this.start);
    this.fields.outcome = outcome;
    Object.assign(this.fields, extra);
    // Swap for a real sink (e.g. batched POST to a logs endpoint) in
    // production — the shape is what matters, not console as the sink.
    console.log(JSON.stringify(this.fields));
  }
}
