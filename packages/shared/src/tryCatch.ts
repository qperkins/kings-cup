/**
 * Every async operation in this codebase that can fail returns a
 * TryCatchResult instead of throwing across a layer boundary (WS handlers,
 * API routes, storage calls). Callers narrow via `result.success` before
 * touching `data` or `error` — no unsafe casts, no un-narrowed `catch (e:
 * any)`. `error` is `unknown` until the caller narrows it, which is the
 * type-correct way to handle a thrown value in TypeScript.
 */

export type TryCatchSuccess<T> = { success: true; data: T };
export type TryCatchError = { success: false; error: unknown };
export type TryCatchResult<T> = TryCatchSuccess<T> | TryCatchError;

export const tryCatch = async <T>(
  operation: () => Promise<T>
): Promise<TryCatchResult<T>> => {
  try {
    const data = await operation();
    return { success: true, data };
  } catch (error) {
    return { success: false, error };
  }
};

/**
 * Same contract, synchronous version — for JSON.parse, schema validation,
 * or any throwing sync call you don't want wrapped in a bare try/catch
 * at the call site.
 */
export const tryCatchSync = <T>(operation: () => T): TryCatchResult<T> => {
  try {
    const data = operation();
    return { success: true, data };
  } catch (error) {
    return { success: false, error };
  }
};
