import { parseTokenRef, type TokenRef } from "@folio/oracle-ref";
import { SUPPORTED_CURRENCIES } from "./fx";
import type { ProviderTokenSeed } from "./types";

// 法币身份(ADR 0025)。法币的 tokenRef = `fiat/issued:<CODE>`(如 `fiat/issued:USD`)——
// 命名者 `fiat` 为 ISO 货币码背书(`issued:` 那一支,有背书),**不是**手敲无背书的 `custom:`。
//
// 范围锁 `SUPPORTED_CURRENCIES` 里 `kind === "fiat"` 的那几种(与展示币种同一集合)——
// 白名单外的 `fiat/issued:XXX` 一律按未知处理,不建 canonical 行(见 mint 的法币分支)。
//
// 这一层只回答两件事:①「这条 ref 是不是白名单法币,是的话 code 是什么」(`fiatCodeOf`,
// mint 建行 / revalue 走 FX 共用);②「建 canonical 法币行用什么 seed」(`fiatSeed`)。
// logo 单一来源 = `SUPPORTED_CURRENCIES` 的内嵌 base64(#268),此处直接复用,不再拉取。

export const FIAT_NAMER = "fiat";

const FIAT_BY_CODE = new Map(
  SUPPORTED_CURRENCIES.filter((c) => c.kind === "fiat").map((c) => [c.code, c] as const),
);

// 建 canonical 法币行的 seed:`symbol=CODE`、图取内嵌 base64。白名单外 → undefined。
// 图落 `providerLogo` 槽:法币没有上游(coingecko)canonical 图,展示回退链里这一份就是要显示的
// 那张;而 `providerLogo` 不会被 `refreshStaleInfo` 覆盖(法币行 ref 为空、从不刷),稳。
export function fiatSeed(code: string): ProviderTokenSeed | undefined {
  const cur = FIAT_BY_CODE.get(code.trim().toUpperCase());
  return cur ? { symbol: cur.code, providerLogo: cur.logo } : undefined;
}

// 一条 ref 若是白名单内的法币身份 → 返回其 CODE(大写);否则 undefined。
// namer 必须是 `fiat` 且 `issued:` 那一支(有背书),code 必须在白名单里 —— 三者缺一按非法币处理。
export function fiatCodeOf(ref: TokenRef): string | undefined {
  const parsed = parseTokenRef(ref);
  if (parsed.kind !== "issued" || parsed.namer !== FIAT_NAMER) return undefined;
  const code = parsed.id.toUpperCase();
  return FIAT_BY_CODE.has(code) ? code : undefined;
}
