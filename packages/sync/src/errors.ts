import { Data } from "effect";

// Failures of our own steps, split by `step`. Upstream failures stay `UpstreamError`.

// No factory: wrapping would widen `_tag` to string and break Effect.catchTag.
export type SyncDepStep =
  | "listAccounts"
  | "listRawCreds"
  | "readCreds"
  | "resolveSource"
  | "writeSnapshot"
  | "mint"
  | "revalue";

export class SyncDepError extends Data.TaggedError("SyncDepError")<{
  readonly step: SyncDepStep;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function depError(step: SyncDepStep, cause: unknown): SyncDepError {
  return new SyncDepError({ step, message: messageOf(cause), cause });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
