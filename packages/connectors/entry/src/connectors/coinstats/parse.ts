import type { CoinstatsCoin } from "@folio/coinstats-client";
import type { Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";

// 【coinstats 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
// 逐字搬自 `packages/connectors/provider-coinstats`,fixtures 一字节没动。
//
// **一份适配服务三条链**(solana / sui / cosmos):差别只有 `connectionId`,解析逻辑一字不差。

function chainTokenRef(chain: string, contract: string | undefined): string {
  return contract ? tokenRef.contract(chain, contract) : tokenRef.native(chain);
}

// 跳过无 symbol;合约行产代币标识(无数字 chainId → 兜底格式);现货行不产 meta(新 schema 无 meta 字段)。
export type Row = Spot;

export function parseBalances(coins: readonly CoinstatsCoin[], fallbackChain: string): Row[] {
  const out: Row[] = [];
  for (const c of coins ?? []) {
    const symbol = c.symbol?.trim();
    if (!symbol) continue;
    const amount = c.amount ?? 0;
    const chain = c.chain?.trim() || fallbackChain;
    out.push({
      symbol,
      amount,
      price: c.price ?? undefined,
      value: amount * (c.price ?? 0),
      kind: "spot",
      // 链/合约身份走 tokenRef,不再进 meta;现货行无展示用 meta → 省略。
      // 有合约 → <slug>/contract:<addr>;无合约(原生币 SOL/SUI…)→ <slug>/native。
      // 地址不小写:base58 / bech32 大小写敏感,归一由 @folio/oracle-ref 按链决定。
      tokenRef: chainTokenRef(chain, c.contractAddress ?? undefined),
      name: c.name,
    });
  }
  return out;
}

// —— 账户级 creds(AC):钱包地址,public(明文落库、可导出重建)。三链共享此声明 ——
