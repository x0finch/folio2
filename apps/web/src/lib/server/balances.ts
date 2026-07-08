import { type Balances, createBalances } from "@folio/balances";
import { resolveProvider } from "./provider-config";

// server-only 门面。全应用唯一 createBalances 调用点;其余处 import { balances } 后直接 balances.xxx。
// 每次属性访问用当前环境造一份实例(廉价);get 在访问时才碰依赖 → 模块加载期不触发。
// 生效 provider 经 resolveProvider 运行时解析(覆盖表 + settings 分层 + 工厂实例化,ADR 0009);
// 全局 key 不再经 globalKeys 每调下发 —— 是实例化参数(见 provider-config.ts)。
export const balances: Balances = new Proxy({} as Balances, {
  get: (_target, prop: string) =>
    (createBalances({ resolveProvider }) as unknown as Record<string, unknown>)[prop],
});
