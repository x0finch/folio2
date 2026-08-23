import { Oracle } from "@folio/oracle";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Clock, Effect, Option } from "effect";
import { pickLocale, readLocaleCookie } from "@/lib/i18n/detect";
import { buildFiatOptions } from "./fiat-options";

// 选币下拉「法币」组:SUPPORTED_CURRENCIES 的 10 法币。**票在服务端造**(前端拿不透明串,与目录/
// 已有/搜索一致;前端绝不构造 tokenRef/票 —— 红线见 ./model 的 `TokenOption`)。货币名按请求 locale 本地化。
// 静态数据、无网络、无 per-user —— 不走边缘缓存、不建行。构造逻辑在纯函数 `buildFiatOptions`
// (server-only 消费,故文法不进客户端 bundle)。
export const handleListFiatOptions = Effect.fn("listFiatOptions")(function* () {
  const headers = getRequestHeaders();
  const locale = pickLocale(
    readLocaleCookie(headers.get("cookie")),
    headers.get("accept-language"),
  );
  const base = buildFiatOptions(locale);
  // 法币的「价」= FX 汇率(USD 恒 1),直接填进下拉项 —— 否则价格列显 "—"(法币在代币价格源没有价)。
  // warm 一次(冷则一把拉全所有支持币种;通常 _authed loader / 切币种时已暖过 → no-op)。
  // asOf 置当下 → 下拉 SWR(staleTickets)判它新鲜、不再拿它去 refreshTokenPrices 白刷(价已现填,重取无意义)。
  // 取不到汇率(warm 失败且非 USD)→ 该项不带价,回退 "—"(降级,不阻断)。24h 涨跌法币不给。
  const { fx } = yield* Oracle;
  yield* fx.warm(base.map((o) => o.symbol));
  const asOf = yield* Clock.currentTimeMillis;
  return yield* Effect.forEach(base, (o) =>
    Effect.map(fx.resolve(o.symbol), (price) =>
      Option.isSome(price) ? { ...o, price: price.value, asOf } : o,
    ),
  );
});
