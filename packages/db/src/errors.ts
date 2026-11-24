import { Data } from "effect";

/** The thing is missing or not the caller's; deliberately one error so probing other users' ids is impossible. */
export class NotFound extends Data.TaggedError("db/NotFound")<{
  readonly entity: string;
  readonly id: string;
}> {
  // Data.TaggedError doesn't build `message`; without it logs show an empty message plus a Cause.
  override get message(): string {
    return `${this.entity} not found: ${this.id}`;
  }
}

/** The input is invalid in this context (e.g. tag pin without tagId, custom tab already full); callers can fix it, so it is in `E`. */
export class InvalidInput extends Data.TaggedError("db/InvalidInput")<{
  readonly what: string;
  readonly why: string;
}> {
  override get message(): string {
    return `${this.what}: ${this.why}`;
  }
}
