import { getRequestHeaders } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import type { PreferCurrency } from "@/lib/hooks/use-prefer-currency";
import { writePreferenceCookie } from "./cookie";
import { CURRENCY_COOKIE, readCurrencyCookie, resolveCurrency } from "./currency-detect";
import { displayRate } from "./fx";

// 展示币种偏好(每浏览器,仿 locale)。纯逻辑半在 ./currency-detect(单测在那边,#527 后续件 1)。

// 服务端定展示币种:读 folio_currency cookie → SUPPORTED 校验 → 取该币种汇率。
// 取汇率的三档判断(USD / 缓存 / 冷缓存按需拉一次)在 ./fx 的 `displayRate` 里,
// 本 handler 只做壳:定币种 → 问汇率 → 套形状。**取不到就整体回退 USD** ——
// 币种是 EUR 而汇率却按 1 算会显示成错的数字,那比显示美元糟得多。
//
// **requireAuth 在 index 装配**(#202b):汇率搬进 per-user 缓存之后取汇率需要 userId。它本来也只被
// `_authed` 的 loader 调用(那里已经 beforeLoad 挡过没登录的),所以对外行为不变 ——
// 「币种偏好不敏感」这个判断仍然成立,只是拿汇率这件事现在需要知道是谁。
//
// **请求头在 effect 里读没问题**:TanStack 用 `AsyncLocalStorage` 存它,而 ALS 跟着异步续体走,
// Effect 自己的调度也不例外(实测过)。仍旧写成第一句 —— 同步那一刻一定还在,不必依赖这条。
export const handleGetCurrencyPreference = Effect.fn("getCurrencyPreference")(function* () {
  const headers = getRequestHeaders();
  const currency = resolveCurrency(readCurrencyCookie(headers.get("cookie")));
  const rate = yield* displayRate(currency.code);
  const preference: PreferCurrency =
    rate == null ? { currency: resolveCurrency("USD"), rate: 1 } : { currency, rate };
  return preference;
});

// 写完不回传新值:调用点照旧走 `invalidateFor`,由那张映射表决定刷哪些读(ADR 0038)。
// 代价是这一次切换会多一个请求(写一次 + 读一次),换来的是失效语义仍然只有一个出处。
export const SetCurrencyInput = z.object({ code: z.string() });

export function handleSetCurrencyPreference({ data }: { data: z.infer<typeof SetCurrencyInput> }) {
  // 落库前先过一遍 SUPPORTED:cookie 是用户可改的输入,别把垃圾写进去让读侧天天兜底。
  writePreferenceCookie(CURRENCY_COOKIE, resolveCurrency(data.code).code);
}
