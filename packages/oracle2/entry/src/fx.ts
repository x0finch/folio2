import type { CacheStore, FxUpstream } from "@folio/oracle2-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle2-basic";
import { cacheKeys, readFx, readFxFreshness, writeFx } from "./cache";

// 展示币种的汇率服务。**读软过期、写按 TTL** —— 两个动词的判据不同,这是本文件的全部内容。
//
// `resolve`(读)不看过期:汇率旧十分钟不会让总资产错到影响决策,而「暂时没有汇率」会让整个
// 认证区拿不到数字。所以有多旧都给,新鲜度由 `warm` 负责往上追。
// `warm`(写)才看过期:任一目标币种缺失或过期 → 一次拉全 → 逐个写回。
export interface FxRates {
  // 1 单位该币种值多少美元。USD 恒 1(不查缓存);缓存里没有 → undefined(调用方回退 USD)。
  resolve(currency: string): Promise<number | undefined>;
  // 预热(同步之后 / 用户第一次切币种时)。缺省预热全部支持币种。
  warm(currencies?: readonly string[]): Promise<void>;
}

export interface FxRatesDeps {
  cache: CacheStore;
  upstream: FxUpstream;
}

const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

// 币种 code 的归一口径,与造缓存键那一处(`cacheKeys.fx`)必须一致。
// 不归一的话「是不是 USD」这个判断会漏掉 `usd`:它既不短路成 1、又永远不会被写进缓存
// (写的时候按大写过滤掉了),于是每次预热都白拉一趟上游。
const norm = (code: string): string => code.trim().toUpperCase();

export function createFxRates({ cache, upstream }: FxRatesDeps): FxRates {
  return {
    async resolve(currency) {
      if (norm(currency) === "USD") return 1;
      return readFx(cache, currency);
    },

    async warm(currencies = ALL_CODES) {
      // USD 不进目标:它恒为 1、不存缓存,算进去会让「全都新鲜」永远判不成立。
      const targets = [...new Set(currencies.map(norm))].filter((c) => c !== "USD");
      if (targets.length === 0) return;

      // 一次批量读:目标全都在且新鲜 → 什么都不做。
      const hits = await readFxFreshness(cache, targets);
      if (targets.every((c) => hits.get(cacheKeys.fx(c))?.stale === false)) return;

      // 一次拉全 → **一个批次**把其余支持币种也写上(反正都在同一份响应里),
      // 下次别人切过去就是热的。逐个写会把一次 D1 批次变成十来次往返。
      const fresh = await upstream.fetchRates();
      await writeFx(
        cache,
        [...fresh]
          .filter(([code]) => norm(code) !== "USD")
          .map(([currency, usdPerUnit]) => ({ currency, usdPerUnit })),
      );
    },
  };
}
