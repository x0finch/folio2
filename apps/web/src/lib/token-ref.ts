import { parseTokenRef } from "@folio/oracle-ref";

// 这条持仓在链上吗?在的话是哪条链 —— 不查表,看 tokenRef 的右半边:`native` / `<ns>:<addr>`
// 是链上寻址,故命名者必是链;不透明 id(`binance/USDC`、`coingecko/usd-coin`)则不是(ADR 0020)。
// 返回的链命名者**同时就是** `platforms.id`(短形:`eip155:<id>` / `<slug>`),可直接拿去查 name+logo。
export function chainOf(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const parsed = parseTokenRef(ref);
  return parsed.kind === "native" || parsed.kind === "contract" ? parsed.namer : undefined;
}
