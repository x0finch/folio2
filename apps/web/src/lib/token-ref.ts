import { parseTokenRef } from "@folio/oracle-ref";

// tokenRef 的 app 侧读法。
//
// 「这个 ref 的命名者是不是一条链?」—— 不查表,看右半边:`native` / `<ns>:<addr>` 是链上寻址,
// 故命名者必是链;不透明 id(`binance/USDC`、`coingecko/usd-coin`)则不是(ADR 0020)。
// 链命名者同时就是 `platforms.id`(短形:`eip155:<id>` / `<slug>`),可直接送去查 name+logo。
export function chainNamerOf(tokenKey: string | null | undefined): string | undefined {
  if (!tokenKey) return undefined;
  const ref = parseTokenRef(tokenKey);
  return ref.kind === "native" || ref.kind === "contract" ? ref.namer : undefined;
}
