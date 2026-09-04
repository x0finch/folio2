// 余额隐私的纯状态(FOL-75,ADR 0052)。主动定时器 / DOM 事件 / React 都不在这层 ——
// 这里只回答「给定开关 + 是否临时显示 + 一个事件,下一态是什么、此刻遮不遮」,好被完整单测。

/**
 * `enabled` = 用户开了隐藏余额(来自 user_settings.hide_balances,或冷启动时的 localStorage 缓存)。
 * `revealed` = 当前这一下临时显示中(用户点了某个值)。两者正交。
 */
export interface PrivacyState {
  enabled: boolean;
  revealed: boolean;
}

export type PrivacyEvent =
  // 权威值到位:服务器读回来的,或冷启动缓存给的。
  | { type: "sync"; hideBalances: boolean }
  // 用户点了某个值 → 临时显示全部。
  | { type: "reveal" }
  // 任何「离开」信号(切后台 / 失焦 / 空闲到点)→ 收回临时显示。
  | { type: "leave" };

export function privacyReducer(state: PrivacyState, event: PrivacyEvent): PrivacyState {
  switch (event.type) {
    case "sync":
      // 关掉隐私时顺手清掉 revealed:没有可显示的东西了,别留个悬着的 true。
      // 值没变就原样返回(引用不变 → React 不白重渲)。
      if (state.enabled === event.hideBalances) {
        return event.hideBalances ? state : state.revealed ? { ...state, revealed: false } : state;
      }
      return { enabled: event.hideBalances, revealed: false };
    case "reveal":
      // 没开隐私时「显示」无意义 → no-op(引用不变)。
      return state.enabled && !state.revealed ? { ...state, revealed: true } : state;
    case "leave":
      return state.revealed ? { ...state, revealed: false } : state;
  }
}

/** 此刻要不要遮:开着隐私、且不在临时显示中。 */
export function isHidden(state: PrivacyState): boolean {
  return state.enabled && !state.revealed;
}

/**
 * 冷启动时 `enabled` 的初值。**fail-closed**:没缓存(还不知道服务器值)→ 先当开(先遮),
 * 等 `sync` 事件校准;有缓存 → 直接用缓存值(缓存是 OFF 就不遮、不闪,ADR 0052 的双向缓存)。
 */
export function resolveInitialEnabled(cached: boolean | null): boolean {
  return cached ?? true;
}

/** 临时显示多久没动作就自动收回(ADR 0052 的「~15s 空闲」)。 */
export const REVEAL_IDLE_MS = 15_000;

/** localStorage 里缓存 hide_balances 的键。值为 "1" | "0"。 */
export const HIDE_BALANCES_CACHE_KEY = "folio_hide_balances";

/** 解析缓存字符串 → 布尔;缺失 / 脏值一律当「没缓存」(→ fail-closed)。 */
export function parseCachedHideBalances(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function serializeHideBalances(value: boolean): string {
  return value ? "1" : "0";
}
