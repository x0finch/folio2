import { FxService } from "@folio/oracle";
import { Effect, Option } from "effect";
import { runRequest } from "../internal/oracle";

// 展示币种的汇率:1 单位该币种值多少美元。**唯一的读入口**,`preferences.ts` 那个 server fn
// 只负责读 cookie、定币种、把结果套成 `PreferCurrency`。
//
// 三档,顺序就是代价从小到大:
//   ① USD 恒 1 —— 不查缓存、不出网
//   ② 缓存里有 —— 多旧都用(软过期:汇率旧十分钟不影响看总资产,「暂时没汇率」才是问题)
//   ③ 冷缓存 —— 按需拉一次再读。这一档是为「第一次切币种」存在的:那时用户可能还没同步过,
//      缓存里什么都没有;没有这一档他会一直看到美元,直到某次同步的后台预热碰巧跑过
//
// **拿不到就是 `undefined`**:只该让页面显示美元,不该让整个认证区加载失败。
// 三种原因(上游没收录这个币种 / 上游挂了 / 缓存冷且拉不到)在这里不区分 —— 调用方处置一样。
// 上游挂了那一档现在由参考层自己降级并记一行日志(`fx.warm` 里的 `degradeTo`),
// 所以这里不再需要一个把什么都吞掉的 `try/catch`(那个连自己的 bug 一起吞)。
export function displayRate(userId: string, code: string): Promise<number | undefined> {
  if (code === "USD") return Promise.resolve(1);
  return runRequest(
    userId,
    Effect.gen(function* () {
      const fx = yield* FxService;
      const cached = yield* fx.resolve(code);
      if (Option.isSome(cached)) return cached.value;
      yield* fx.warm([code]); // 冷缓存 → 拉一次(上游那个端点一把全给,顺手把其余币种也写上)
      return Option.getOrUndefined(yield* fx.resolve(code));
    }),
  );
}
