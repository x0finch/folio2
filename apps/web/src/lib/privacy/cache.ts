import { HIDE_BALANCES_CACHE_KEY, parseCachedHideBalances, serializeHideBalances } from "./state";

// hide_balances 的 localStorage **双向**缓存(ADR 0052)。冷启动同步读它当初值,消掉「等服务器读回来
// 之前那一下模糊闪现」;每次权威值变化都写回。读写都吞异常:隐私窗口 / 禁用存储时 localStorage 会
// 抛,抛了就退回「没缓存」→ fail-closed(state.ts 的 resolveInitialEnabled)。同 idle-lock 的做法。

export function readCachedHideBalances(): boolean | null {
  try {
    return parseCachedHideBalances(localStorage.getItem(HIDE_BALANCES_CACHE_KEY));
  } catch {
    return null;
  }
}

export function writeCachedHideBalances(value: boolean): void {
  try {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, serializeHideBalances(value));
  } catch {
    // storage 不可用:退回「无缓存」,下次冷启动 fail-closed 先遮一下 —— 可接受。
  }
}
