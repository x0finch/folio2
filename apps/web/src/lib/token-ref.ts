import { isChainNamer } from "@folio/oracle";
import { parseTokenRef } from "@folio/oracle-ref";

// 这条持仓在链上吗?在的话是哪条链。文法收窄前看右半边形状就够(`<ns>:<addr>` 即链上寻址);
// 收窄后 `evm:1/0xa0b8…` 与 `binance/USDC` 同形 → 改问左半边是不是链(isChainNamer)。
// 这是临时判据:平台改由 provider 随余额直接报之后(#193),本函数整个删除。
// 返回的链命名者**同时就是** `platforms.id`(短形:`evm:<id>` / `<slug>`),可直接拿去查 name+logo。
export function chainOf(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const parsed = parseTokenRef(ref);
  if (parsed.kind === "unknown") return undefined;
  return isChainNamer(parsed.namer) ? parsed.namer : undefined;
}

// 「某条链上的某个地址」—— 链命名者 + 非原生币。sync 采集 provider 元信息时只 seed 这种行
// (原生币走 symbol 解析,`coingecko/<id>` 已是规范 ref)。同为 #193 之后要删的临时判据。
export function chainAddressOf(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const parsed = parseTokenRef(ref);
  return parsed.kind === "local" && isChainNamer(parsed.namer) ? ref : undefined;
}
