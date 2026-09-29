import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { consumeMessage } from "@/lib/server/jobs/consume";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// 合并进 tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tokens/list-fiat-options", () => {
  // #527 · listFiatOptions
  //
  // 以前这组全是 skip:handler 经 `getRequestHeaders()` 读请求语言,这套 workers 配置里 import 不进来。
  // 语言改成调用方传参之后(界面语言住浏览器,ADR 0049 补记)那道墙没了。
  // 「按语言给名字」那半的细节另有 `tests/fiat-options.test.ts`;这里测的是 handler 自己那半 ——
  // 顺带把汇率贴上去,以及取不到时怎么降级。
  const USER = "h-tok-fiat";

  // 上游以 BTC 为基准:value = 1 BTC 值多少该币种。KRW 故意不给 —— 「上游没收录」那一档。
  const RATES = {
    rates: {
      btc: { value: 1, type: "crypto" },
      usd: { value: 100000, type: "fiat" },
      eur: { value: 92000, type: "fiat" },
    },
  };

  const bySymbol = <T extends { symbol: string }>(options: readonly T[], symbol: string) =>
    options.find((o) => o.symbol === symbol);

  // 汇率只由队列的 `fx` 活暖(FOL-88),handler 自己只读缓存 —— 要带价的用例先跑一条。
  const warmFx = () =>
    Effect.runPromise(
      consumeMessage({
        id: "m-fx",
        body: { kind: "fx", userId: USER },
        attempts: 1,
        ack: () => {},
        retry: () => {},
      }),
    );

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("listFiatOptions", () => {
    it("返回一批法币,取得到汇率的带价和取到的时刻", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      await warmFx();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));

      expect(out.length).toBeGreaterThan(1);
      const eur = bySymbol(out, "EUR") as { price?: number; asOf?: number };
      expect(eur.price).toBeCloseTo(100000 / 92000, 6);
      expect(eur.asOf).toBeTruthy();
    });

    it("USD 的汇率是 1", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect((bySymbol(out, "USD") as { price?: number }).price).toBe(1);
    });

    it("locale 是 zh → 名字是中文", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      const out = await call(USER, handleListFiatOptions({ locale: "zh" }));
      expect(bySymbol(out, "EUR")?.name).toBe(
        new Intl.DisplayNames(["zh"], { type: "currency" }).of("EUR"),
      );
    });

    it("认不出的 locale → 回落默认语言(码是调用方可改的输入)", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      const junk = await call(USER, handleListFiatOptions({ locale: "x".repeat(64) }));
      const en = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(junk.map((o) => o.name)).toEqual(en.map((o) => o.name));
    });

    it("某个法币取不到汇率 → 只缺那一项,不是整批失败", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      await warmFx();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      const krw = bySymbol(out, "KRW") as { price?: number } | undefined;
      expect(krw).toBeDefined();
      expect(krw?.price).toBeUndefined();
      expect((bySymbol(out, "EUR") as { price?: number }).price).toBeDefined();
    });

    it("汇率上游整个挂了 → 选项照样给,界面还能选", async () => {
      stubOutbound([["/exchange_rates", () => json({ error: "down" }, 503)]]);
      await warmFx();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(out.length).toBeGreaterThan(1);
      // USD 恒 1 不靠上游;其余没价。
      expect((bySymbol(out, "EUR") as { price?: number }).price).toBeUndefined();
    });
  });
});
