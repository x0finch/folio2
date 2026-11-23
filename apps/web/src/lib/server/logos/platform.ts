import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { serveLogo } from "./serve";

// Venue keys use the connector's own image and short-circuit in the route.
export const platformLogo = Effect.fn("platformLogo")(function* (key: string) {
  const url = (yield* Effect.flatMap(Oracle, (o) => o.platforms.resolve([key]))).get(key)?.logo;
  return yield* Effect.promise(() =>
    serveLogo(async () => url, "platform", key, { private: true }),
  );
});
