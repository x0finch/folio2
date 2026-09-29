import { Effect } from "effect";
import { z } from "zod";
import type { PreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { resolveCurrency } from "./currency-detect";
import { displayRate } from "./fx";

// 展示币种:**选哪个币种是浏览器的事**(localStorage,见 lib/hooks/use-prefer-currency),
// **那个币种值多少美元是服务端的事**(per-user 的汇率缓存)。所以码作为参数传进来,这里只取汇率。
// 以前码存在 cookie 里、由这里读请求头 —— HTML 变成静态资源之后(ADR 0049 补记)没有谁再需要
// 服务端知道它,而「服务端猜一份、客户端也猜一份」正是双份真相。
//
// 取汇率的两档判断(USD / 缓存,**都不出网**,FOL-88)在 ./fx 的 `displayRate` 里,
// 本 handler 只做壳:定币种 → 问汇率 → 套形状。**取不到就整体回退 USD** ——
// 币种是 EUR 而汇率却按 1 算会显示成错的数字,那比显示美元糟得多。
//
// **requireAuth 在 index 装配**(#202b):汇率在 per-user 缓存里,取汇率需要 userId。
export const CurrencyPreferenceInput = z.object({ code: z.string() });

export const handleGetCurrencyPreference = Effect.fn("getCurrencyPreference")(function* (
  data: z.infer<typeof CurrencyPreferenceInput>,
) {
  // 码是调用方给的输入,垃圾在这儿拦(未知 → USD)。
  const currency = resolveCurrency(data.code);
  const rate = yield* displayRate(currency.code);
  const preference: PreferCurrency =
    rate == null ? { currency: resolveCurrency("USD"), rate: 1 } : { currency, rate };
  return preference;
});
