import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { serveLogo } from "./serve";

// 平台 logo 代理(链键):platform key → 上游图 → 透传 + 缓存头。场馆键走连接器自带图,在路由里短路。
export const platformLogo = Effect.fn("platformLogo")(function* (key: string) {
  const url = (yield* Effect.flatMap(Oracle, (o) => o.platforms.resolve([key]))).get(key)?.logo;
  return yield* Effect.promise(() =>
    serveLogo(async () => url, "platform", key, { private: true }),
  );
});
