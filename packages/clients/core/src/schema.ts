import { Schema } from "effect";

// Upstreams express "absent" both as a missing key and as `null`, sometimes for the same field.
// Accepts `X | null | undefined`, decodes to `X | undefined`. Where null ≠ missing (hyperliquid's
// `liquidationPx`), use `Schema.optional(Schema.NullOr(X))` instead.
export const maybe = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.optionalWith(schema, { nullable: true });
