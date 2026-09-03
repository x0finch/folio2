import { createContext, useContext } from "react";

// 余额隐私的 Context + 读取 hook(FOL-75,ADR 0052)。**只放这两样,不 import Provider**:
// `<Sensitive>` / `<AmountTicker>` 等展示件只要 `useBalancePrivacy`,它们进得了 node 组件测试;
// 而 Provider 要读 `valuationSettingsQuery`,那条链上挂着 server-only 的 `cloudflare:workers`
// (见 queries/keys.ts 的注),import 进 node 测试就炸。拆开后展示件这一侧不碰 server 链。
// Provider 在 ./provider。

export interface BalancePrivacy {
  /** 此刻要不要遮。 */
  hidden: boolean;
  /** 点了某个值:临时显示全部(点一处全显)。 */
  reveal: () => void;
}

export const BalancePrivacyContext = createContext<BalancePrivacy | null>(null);

// 没有 Provider 时的缺省:隐私关(永不遮)。Provider 在认证区顶层恒挂;拿不到它的场景
// (孤立渲染的组件测试、认证区之外万一复用某个金额件)按「不遮」渲染即可,别抛异常把页面打没。
const PRIVACY_OFF: BalancePrivacy = { hidden: false, reveal: () => {} };

export function useBalancePrivacy(): BalancePrivacy {
  return useContext(BalancePrivacyContext) ?? PRIVACY_OFF;
}
