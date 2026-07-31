import { FIAT_NAMER, SUPPORTED_CURRENCIES, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { TokenOption } from "./token-option";

// 选币下拉「法币」组的数据(#272)。范围锁 `SUPPORTED_CURRENCIES` 里 `kind === "fiat"` 的那几种
// (与展示币种同一集合,扩展 = 往那个常量加一处)。每项:
//   · `ticket` 携带 `fiat/issued:<CODE>` —— 与加密币的票同一种不透明串,前端原样搬运,提交时
//     mintHolding 解票(命名者集合含 `fiat`)→ mint 建 / 复用一条 canonical 法币行(#270)。
//   · `symbol = CODE`(USD/EUR…),`logo` 取 `SUPPORTED_CURRENCIES` 的内嵌 base64(单一来源,#268)。
//   · **不带 `price`** —— 法币没有上游市价;选中后由 getTokenPrice 走 FX 预填(USD=1,其余当前汇率)。
//
// **纯客户端常量**(不走 server fn):静态数据、无 per-user、无网络 —— 与读库的 listUserTokens 不同,
// 为它开一趟往返纯属浪费。`tokenTicket` / 常量都来自 `@folio/oracle-basic`(client-safe,无 provider 图)。
//
// 货币名走 `Intl.DisplayNames`(平台自带,随 UI locale)—— 不硬编码一张名字表(与 date-time-wheel
// 用 `Intl.DateTimeFormat` 同口径)。取不到名字(极老运行时)→ 退回 CODE,不至于空着。
export function buildFiatOptions(locale: string): TokenOption[] {
  const names = new Intl.DisplayNames([locale], { type: "currency" });
  return SUPPORTED_CURRENCIES.filter((c) => c.kind === "fiat").map((c) => ({
    ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, c.code)),
    symbol: c.code,
    name: names.of(c.code) ?? c.code,
    logo: c.logo,
  }));
}
