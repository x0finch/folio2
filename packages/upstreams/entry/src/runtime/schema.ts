import { Option, Predicate, Schema, SchemaGetter } from "effect";

// Upstreams express "absent" both as a missing key and as `null`, sometimes for the same field.
// Accepts `X | null | undefined`, decodes to `X | undefined`. Where null ≠ missing (hyperliquid's
// `liquidationPx`), use `Schema.optional(Schema.NullOr(X))` instead.
export const maybe = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(Schema.optional(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
      encode: SchemaGetter.passthrough(),
    }),
  );
