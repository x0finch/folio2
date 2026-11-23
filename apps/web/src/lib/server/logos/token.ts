import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";
import { serveLogo } from "./serve";

export const tokenLogo = Effect.fn("tokenLogo")(function* (id: string) {
  const url = Option.getOrUndefined(yield* Effect.flatMap(Oracle, (o) => o.tokens.logoUrlById(id)));
  return yield* Effect.promise(() => serveLogo(async () => url, "token", id, { private: true }));
});
