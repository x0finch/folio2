import { describe, it } from "vitest";

// 合并进 tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tokens/list-fiat-options", () => {
  // #527 · listFiatOptions
  //
  // 与 cookie 偏好那组同一道墙:这个 handler 也经 `getRequestHeaders()`(它按请求语言排法币名),
  // 所以在这套 workers-pool 配置里 import 不进来 —— 探针实测报的是
  // `Missing "#tanstack-router-entry" specifier in "@tanstack/start-server-core"`。
  //
  // 它的两半可以分开看:
  //   · **「按语言给名字」** 那半已经有测试 —— `tests/fiat-options.test.ts` 直接测
  //     `@/lib/server/tokens/fiat-options` 的 `buildFiatOptions(locale)`,不碰请求上下文。
  //   · **「顺带把汇率贴上去」** 那半在这个 handler 里,没有测试,而它才是会出事的那半
  //     (某个法币取不到汇率时,该只缺那一项还是整批失败)。
  //
  // 出路同 `preferences/cookie-prefs.test.ts` 那三条 —— 最省的仍是把「读语言」抽成纯函数,
  // handler 只剩「取汇率 + 贴上」,那时它就能在这一层测了。
  describe("listFiatOptions", () => {
    it.skip("返回一批法币,每个带当前汇率和取到的时刻(要请求上下文)", () => {});
    it.skip("请求语言是 zh → 名字是中文(同上;buildFiatOptions 那半已有测试)", () => {});
    it.skip("USD 的汇率是 1(同上)", () => {});
    it.skip("某个法币取不到汇率 → 只缺那一项,不是整批失败(同上)", () => {});
    it.skip("汇率上游整个挂了 → 选项照样给,界面还能选(同上)", () => {});
    it.skip("accept-language 是没听过的 tag → 回落默认语言(同上)", () => {});
  });
});
