import { type Defi, ProviderError, type Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { z } from "zod";
import { DUST_USD } from "./constants";
import type { RabbyChain, RabbyProtocol, RabbyToken } from "./types";

// Rabby 响应 → Balance 行。**纯函数,与 IO 分离** —— fixture golden test 靠这一点(原则 #2)。

type SpotRow = z.infer<typeof Spot>;
type DefiRow = z.infer<typeof Defi>;

// slug → 数字 chainId。上游的 `community_id` 就是规范 EVM chainId(抽查 15 条全中),
// 所以 tokenRef 与 Zerion 时代逐字节一致 —— **存量快照/代币行/ref 索引不需要迁移**。
export function parseChainIds(chains: readonly RabbyChain[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chains) {
    if (!c.id || typeof c.community_id !== "number" || !Number.isFinite(c.community_id)) continue;
    out[c.id] = c.community_id;
  }
  return out;
}

// 某条持仓的规范代币标识。**恒产出或抛错**,绝不退化成 `chain:<slug>` 兜底形 ——
// 分叉的标识会污染代币索引,比整轮同步失败重试糟得多(「失败即不产」,沿用 Zerion 那条)。
//
// 原生 gas 币的判据:上游把 `id` 填成**链 slug**(如 `"eth"` / `"bb"`)而不是 0x 地址。
// 走 `tokenRef.contract` 而非 `issued`,是在声明「这条 ref 的 symbol 由合约部署者填、不可信」(ADR 0020)。
function refOf(token: RabbyToken, chainIds: Record<string, number>): string {
  const chain = token.chain;
  const chainId = chain ? chainIds[chain] : undefined;
  if (chainId === undefined) {
    throw new ProviderError(
      "UPSTREAM_ERROR",
      `rabby: no chainId for chain '${chain ?? "?"}' (${token.symbol ?? "?"})`,
    );
  }
  const namer = `evm:${chainId}`;
  const id = token.id ?? "";
  return id.startsWith("0x") ? tokenRef.contract(namer, id) : tokenRef.native(namer);
}

// 共享基座:symbol / 数量 / 单价 / 价值 / 标识 / 元信息。
// `sign` 给负债腿用 —— **符号挂在 amount 上,单价保持正**:下游 revalue 会用 正量 × 正价 重算 value,
// 挂在 value 上会被抹掉,净值就不扣债了。
function baseRow(token: RabbyToken, chainIds: Record<string, number>, sign: 1 | -1) {
  const amount = sign * Math.abs(token.amount ?? 0);
  const price = token.price ?? undefined;
  return {
    symbol: token.symbol as string,
    amount,
    price,
    // 上游**不给** usd_value,自己乘。认不出价的币上游给 0 → value 0(dust 闸据此丢)。
    value: amount * (price ?? 0),
    tokenRef: refOf(token, chainIds),
    name: token.name ?? undefined,
    logo: token.logo_url ?? undefined,
  };
}

// 钱包现货(/v1/user/cache_token_list)→ spot[]。
//
// dust 闸的由来:Zerion 有服务端 `filter[trash]=only_non_trash`,rabby **没有对应参数** ——
// 某个公开地址实测 2302 行里 814 行上游根本不给价。不设闸,快照行数涨十几倍。
// 原生币豁免:某条链的 gas 币再小也留,否则那条链会整个从视野里消失。
//
// **能筛的就只有价值这一条,别去筛"币的质量"。** 这个端点上:
//   · `is_core` / `is_verified` / `is_wallet` 全 true,`is_scam` / `is_suspicious` 全 false ——
//     一行都滤不掉。(`cache_token_list` 本身就是 core-only 那份:它的 eth 行数与
//     `token_list?chain_id=eth&is_all=false` 实测同为 1082。老仓库那个 `token.isCore` 滤在这里是空转。)
//   · `credit_score` 确实有区分度,但性价比差得远:`credit_score === 0` 砍 27% 行数、丢 $23,678
//     (总额 2.68%),而 dust 抬到 $1 砍 51% 行数只丢 $104(0.01%)。它删的是**有价格的** memecoin
//     (SNEZHOK $7363、WCHAN $2940 …),留下便宜但"体面"的行 —— 方向就是反的。而且它是个没有文档的
//     字段,0 也可能只是"还没数据",于是用户刚买的新币会静默消失。
// 所以这里只按价值筛。
export function parseTokens(
  tokens: readonly RabbyToken[],
  chainIds: Record<string, number>,
): SpotRow[] {
  const out: SpotRow[] = [];
  for (const t of tokens) {
    if (!t.symbol) continue; // 产不出能看的行
    if (t.is_scam || t.is_suspicious) continue;
    const row = baseRow(t, chainIds, 1);
    const isNative = !(t.id ?? "").startsWith("0x");
    if (!isNative && row.value < DUST_USD) continue;
    out.push({ ...row, kind: "spot" });
  }
  return out;
}

// 协议仓位(/v1/user/complex_protocol_list)→ defi[]。
//
// 一个 protocol 下若干 portfolio_item,每个 item 的 detail 里可能有几个代币列表 —— 每个代币出一行。
// **borrow 腿取负**:上游 `borrow_token_list` 里的 amount 是**正数**(实测 aave3:borrow USDT
// amount=0.182535、price=0.9988,负债语义只体现在「它在 borrow 列表里」+ stats.debt_usd_value),
// 所以取负这一步只能我们做。
// reward 腿按正 —— 那是待领收益,不是负债。
// **不过 dust 闸**:协议仓位本就是被上游筛过的,再筛会让净值对不上账。
export function parseProtocols(
  protocols: readonly RabbyProtocol[],
  chainIds: Record<string, number>,
): DefiRow[] {
  const out: DefiRow[] = [];
  for (const p of protocols) {
    const protocol = p.name ?? p.id ?? undefined;
    for (const item of p.portfolio_item_list ?? []) {
      const detail = item.detail;
      if (!detail) continue;
      // 展示性的键(description / health_rate / unlock_at / end_at)不产行 —— 只有代币列表产行。
      const legs: Array<[readonly RabbyToken[], 1 | -1]> = [
        [detail.supply_token_list ?? [], 1],
        [detail.reward_token_list ?? [], 1],
        [detail.token ? [detail.token] : [], 1], // 单数形状(Vesting 等);老仓库 types.ts 漏了它
        [detail.borrow_token_list ?? [], -1],
      ];
      for (const [tokens, sign] of legs) {
        for (const t of tokens) {
          if (!t.symbol) continue;
          out.push({
            ...baseRow(t, chainIds, sign),
            kind: "defi",
            meta: { protocol, positionType: item.name ?? undefined },
          });
        }
      }
    }
  }
  return out;
}
