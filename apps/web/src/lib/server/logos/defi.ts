import { Effect, Option } from "effect";
import { serveLogo } from "./serve";
import { readDefiLogo } from "./store";

// DeFi 协议 logo 代理:协议名 → 该用户缓存里那条协议图 URL → 透传 + 缓存头。
export const defiLogo = Effect.fn("defiLogo")(function* (protocol: string) {
  const url = Option.getOrUndefined(yield* readDefiLogo(protocol));
  return yield* Effect.promise(() =>
    serveLogo(async () => url, "defi", protocol, { private: true }),
  );
});
