import { ConnectorUnavailableError, type Defi, type Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { ZerionPositionsResponse } from "@folio/zerion-client";

// 【zerion 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
// 逐字搬自 `packages/connectors/provider-zerion`,fixtures 一字节没动。
//
// `parseChainIds` 与那份 24h 缓存**不在这里** —— 它们随 `chainIds` 端点一起进了
// `@folio/zerion-client`:「slug → 数字 chainId 怎么问、问回来缓存多久」是跟上游打交道的事。

// 本 connector 会吐的 kind 子集:spot(代币)| defi(协议仓位)。
export type Row = Spot | Defi;

// 负债类 position_type:数量/价值取负(负债 = 负头寸)。Zerion 的 value 虽自带负号,但下游 revalue/
// liveValue 会用 正amount × 正单价 重算而丢符号 —— 故把 **amount** 取负(单价保持正),value=amount×单价
// 在 parse/重估/读时三处都自然为负,净值才正确扣债。
const DEBT_POSITION_TYPES = new Set(["loan", "borrow"]);

// EVM 持仓的 tokenRef:命名者恒为 `evm:<chainId>`(数字 chainId 由 getChainIds 保证)。
// 合约币 → `contract:<addr>`;原生 gas 币 → `native`。**恒产出** —— 该链没有实现的行在调用处
// 就跳过了(拿不到地址就没有规范身份可言,见 parsePositions)。
// 走 `tokenRef.contract` 而不是 `tokenRef.issued`,是在声明「这条 ref 的 symbol 由合约部署者填、不可信」
// (ADR 0020 第三轮:认币的 symbol 那一档据此跳过它)。
function evmTokenRef(chainId: number, contract: string | undefined): string {
  const namer = `evm:${chainId}`;
  return contract ? tokenRef.contract(namer, contract) : tokenRef.native(namer);
}

// chainIds 必传(由 getChainIds 保证非空):某仓位的链拿不到数字 chainId 就【抛错】——
// 绝不退化成 chain:<slug> 兜底形(那会与规范形分裂身份、污染代币索引),失败即不产、整轮重试。
// 代币元信息:name/icon.url 上 Row(喂参考层)。
export function parsePositions(
  res: ZerionPositionsResponse,
  chainIds: Record<string, number>,
): Row[] {
  const out: Row[] = [];
  for (const p of res.data ?? []) {
    const a = p.attributes;
    if (!a || a.flags?.displayable === false) continue;
    const symbol = a.fungible_info?.symbol;
    if (!symbol) continue;
    const chain = p.relationships?.chain?.data?.id;
    const chainId = chain ? chainIds[chain] : undefined;
    if (chainId === undefined) {
      // 失败即不产:无数字 chainId → 无法产规范标识 → 硬失败(可重试),不产分叉的 slug 兜底形。
      // 归「够不到上游」而不是「读不动」:链清单是 24h 缓存的,拿不到某条链多半是那份映射
      // 还没刷新到,下一轮就好了 —— 可重试。
      throw new ConnectorUnavailableError({
        message: `zerion: no chainId for chain '${chain ?? "?"}' (${symbol})`,
      });
    }
    const isDefi = a.position_type !== "wallet" || Boolean(a.protocol);
    // 当前链的实现:有 address = 合约币;该链有实现但 address 为 null = 原生 gas 币。
    const impl = a.fungible_info?.implementations?.find((i) => i.chain_id === chain);
    // 该链没有任何实现 → 既不是合约币也不是原生币,产不出规范标识。与「无 symbol」一样跳过这行,
    // 而不是产一个没有标识的行(tokenRef 必填,见 Balance 契约)。
    if (!impl) continue;
    const contract = impl.address ?? undefined;
    // 负债腿:amount/value 归一为负(见 DEBT_POSITION_TYPES 注释)。单价 price 保持正(诚实单价)。
    const debt = a.position_type != null && DEBT_POSITION_TYPES.has(a.position_type);
    const sign = debt ? -1 : 1;
    const base = {
      symbol,
      amount: sign * Math.abs(a.quantity?.float ?? 0),
      price: a.price ?? undefined,
      value: sign * Math.abs(a.value ?? 0),
      tokenRef: evmTokenRef(chainId, contract),
      name: a.fungible_info?.name,
      logo: a.fungible_info?.icon?.url,
    };
    if (isDefi) {
      // defi:带 meta(protocol/positionType)。
      out.push({
        ...base,
        kind: "defi",
        meta: { protocol: a.protocol ?? undefined, positionType: a.position_type },
      });
    } else {
      // spot:新 schema 无 meta 字段。
      out.push({ ...base, kind: "spot" });
    }
  }
  return out;
}
