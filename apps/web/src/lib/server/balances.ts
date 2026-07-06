import { env } from "cloudflare:workers";
import { type Balances, createBalances } from "@folio/balances";

// server-only 门面(引 cloudflare:workers)。全应用唯一 createBalances 调用点;其余处 import { balances } 后
// 直接 balances.xxx。每次属性访问用「当前 env」造一份实例(廉价);get 在访问时才碰 env → 模块加载期不触发,
// env 在 fetch 与 scheduled 上下文均可用(见 configureLogging)。secretsKey/globalKeys 从 env 绑入。
export const balances: Balances = new Proxy({} as Balances, {
  get: (_target, prop: string) =>
    (
      createBalances({
        globalKeys: {
          ZERION_API_KEY: env.ZERION_API_KEY,
          COINSTATS_API_KEY: env.COINSTATS_API_KEY,
          // 可选自托管 Esplora 节点(空 → provider 回退公共 mempool.space)。
          BITCOIN_ESPLORA_BASE: env.BITCOIN_ESPLORA_BASE,
        },
      }) as unknown as Record<string, unknown>
    )[prop],
});
