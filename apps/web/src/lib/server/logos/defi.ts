import { Effect, Option } from "effect";
import { serveLogo } from "./serve";
import { readDefiLogo } from "./store";

export const defiLogo = Effect.fn("defiLogo")(function* (protocol: string) {
  const url = Option.getOrUndefined(yield* readDefiLogo(protocol));
  return yield* Effect.promise(() =>
    serveLogo(async () => url, "defi", protocol, { private: true }),
  );
});
