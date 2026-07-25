import type { RefMapResult } from "./coingecko/ref-map";
import type { CgkRefStore, TokenSource } from "./stores";
import type { TokenRef } from "./types";

export interface CgkRefsDeps {
  store: CgkRefStore;
  source: TokenSource;
  // 对照失配是**静默故障**(那条链的币从此没价没图,却不报错)→ 必须喊出来。
  // 做成回调而不是引一个日志库:这一层不该知道日志怎么落,cron 那头知道。
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
}

// 全局 contract → coin 映射(ADR 0022):写路径靠它把「某条链上的某个地址」翻成「哪个币」,
// 全程本地、不碰网络。表由 cron 一天一次整份刷新。
export interface CgkRefs {
  // 正查一批。miss 的键不出现在结果里。
  lookup(refs: readonly TokenRef[]): Promise<Map<TokenRef, string>>;
  // cron 调用点:拉 → 转换 → 灌,一次整份。返回这轮的账,供调用方记日志。
  refresh(now: number): Promise<RefreshSummary>;
  // 最近一次成功刷新的时刻;从未刷过 → null(首次部署要手动触发一次,否则全靠兜底单查)。
  refreshedAt(): Promise<number | null>;
}

export type RefreshSummary = RefMapResult;

export function createCgkRefs({ store, source, onWarn }: CgkRefsDeps): CgkRefs {
  return {
    lookup: (refs) => (refs.length === 0 ? Promise.resolve(new Map()) : store.lookup(refs)),

    refreshedAt: () => store.refreshedAt(),

    async refresh(now) {
      const result = await source.fetchRefMap();
      if (result.unmatchedPlatforms.length > 0) {
        onWarn?.("cgk_refs: 非 EVM 链对照失配,这些链的币将没价没图", {
          platforms: result.unmatchedPlatforms,
        });
      }
      // 一次 store 写(实现内部分批 —— 四万行,D1 一条 batch 塞不下)。
      await store.putAll(result.rows, now);
      return result;
    },
  };
}
