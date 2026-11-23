import { Data } from "effect";

// Failure types by injected capability. Balance-fetch failures are `ConnectorError`; the other five share one type, split by `step`.

// No factory: wrapping would widen `_tag` to string and break Effect.catchTag.
export type SyncDepStep = "listAccounts" | "listRawCreds" | "writeSnapshot" | "mint" | "revalue";

export class SyncDepError extends Data.TaggedError("SyncDepError")<{
  readonly step: SyncDepStep;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function depError(step: SyncDepStep, cause: unknown): SyncDepError {
  return new SyncDepError({ step, message: messageOf(cause), cause });
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
