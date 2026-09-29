import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";

// 展示币种的汇率:1 单位该币种值多少美元。**唯一的读入口**,`currency.ts` 那个 handler
// 只负责校验调用方传来的币种码、把结果套成 `PreferCurrency`。
//
// 两档,**都不出网**:
//   ① USD 恒 1 —— 不查缓存
//   ② 缓存里有 —— 多旧都用(软过期:汇率旧几小时不影响看总资产,「暂时没汇率」才是问题)
//
// **拿不到就是 `undefined`**:只该让页面显示美元,不该让整个认证区加载失败。
// 原因(上游没收录 / 上游挂了 / 这个用户的汇率还没暖过)在这里不区分 —— 调用方处置一样。
//
// **以前还有第三档**:冷缓存就当场 `fx.warm` 拉一次(为「第一次切币种」)。那是一个**读**端点顺手
// 打上游、写库,而这条读挂在外壳的 loader 上,每个页面都走(FOL-88 删)。汇率现在只由队列的 `fx`
// 活刷(每小时给每个用户投一条,一把写全部支持币种),所以「第一次切币种」只在新用户的第一个
// 小时里会落空 —— 那时显示美元,切换器会提示一句(`components/currency-switcher`)。
//
// **不再收 userId、也不再自己发动**(#504 T7):它现在是一段 effect,由调用它的 handler
// 带着一起交给 `runEffect`。参考层从聚合 `Oracle` 一张门票取(T15),不再点名 `FxService`。
export const displayRate = (
  code: string,
): Effect.Effect<number | undefined, never, Oracle | DbRequest> =>
  code === "USD"
    ? Effect.succeed(1)
    : Effect.flatMap(Oracle, ({ fx }) => Effect.map(fx.resolve(code), Option.getOrUndefined));
