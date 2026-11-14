// An error in the person's words (apart from Brain.tsx since 3.5.11: the chat needs it at once).
import { ApiError } from "./api.js";
import { tOptional } from "./i18n.js";

/** An error in plain words: its code when the server gives one, otherwise its message. */
export function explain(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  const vars = err instanceof ApiError ? err.vars : undefined;
  return (code && tOptional(`err_${code}`, vars)) || (err as Error).message;
}
