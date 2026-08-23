import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";
import { serveLogo } from "./serve";

// 代币 logo 代理:内部代币行 id → 经该用户的参考层拿上游图 → 透传 + 缓存头。
export const tokenLogo = Effect.fn("tokenLogo")(function* (id: string) {
  const url = Option.getOrUndefined(yield* Effect.flatMap(Oracle, (o) => o.tokens.logoUrlById(id)));
  return yield* Effect.promise(() => serveLogo(async () => url, "token", id, { private: true }));
});
