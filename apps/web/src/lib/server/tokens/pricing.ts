import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { fiatCodeOf, type TokenRef, tokenTicket } from "@folio/oracle-basic";
import { Clock, Effect, Option } from "effect";

// 选币的「一批票 → 价」分流(#202b 三个选币 server fn 里那段的共同芯)。**两条路**:
//   · 法币 —— 代币价格源里没有它的价,走 FX 现汇(USD 恒 1、其余当天汇率、无 24h 涨跌;ADR 0025)。
//   · 其余 —— 走代币价格源(pricesByRefs)。
// 判据是 `fiatCodeOf`:命中白名单法币 → 走 FX;白名单外的 `fiat/issued:XXX` 落回代币源(拿不到价而已)。
//
// 取数走 `R` 通道(聚合 `Oracle` 的 `tokens` / `fx`)—— 迁移前是四个注入回调
// (`resolveFiat` / `warmFiat` / `priceCrypto` / `now`),而那正是「配置对象上挂回调」那个模式:
// 「这一步会失败成什么」离开了类型,而且两个 server fn 各写一遍同样的四行接线。
// 本函数只干三件与网络无关的事:**解票 → 按 fiatCodeOf 分流 → 拼回票**。
//
// **法币只读缓存,从不 `fx.warm`**(FOL-88,code review #8):汇率由每小时的 `fx` 队列活暖着,
// 请求里不为它出网、也不写 user_cache。缓存冷(新用户的第一个钟头)→ 那张法币票不出现,
// 调用方照「无价」降级,下一个整点就有了。

export interface TickerPrice {
  unitPrice: number;
  change24h?: number;
  asOf: number;
}

export interface PricedTicket {
  ticket: string;
  unitPrice: number;
  change24h: number | null;
  asOf: number;
}

export interface PriceTicketsOptions {
  // 放行的命名者集合(当前代币上游 + `fiat`)。别家命名者的票解不开 → 丢弃(#223 同款自证)。
  namers: readonly string[];
}

export const priceTickets = (
  tickets: readonly string[],
  options: PriceTicketsOptions,
): Effect.Effect<PricedTicket[], never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    // 票 → ref(解不开 / 别家命名者的丢掉),并记 ref→票 好把结果映射回票。同一 ref 的重复票收敛成一条。
    const byRef = new Map<TokenRef, string>();
    for (const ticket of tickets) {
      const ref = tokenTicket.decode(ticket, options.namers);
      if (ref) byRef.set(ref, ticket);
    }
    if (byRef.size === 0) return [];

    const fiatByCode = new Map<string, string>(); // code → 票
    const cryptoRefs: TokenRef[] = [];
    for (const [ref, ticket] of byRef) {
      const code = fiatCodeOf(ref);
      if (code) fiatByCode.set(code, ticket);
      else cryptoRefs.push(ref);
    }

    const out: PricedTicket[] = [];

    if (cryptoRefs.length > 0) {
      const priced = yield* Effect.flatMap(Oracle, (o) => o.tokens.pricesByRefs(cryptoRefs));
      for (const [ref, price] of priced) {
        const ticket = byRef.get(ref);
        if (ticket) {
          out.push({
            ticket,
            unitPrice: price.unitPrice,
            change24h: price.change24h ?? null,
            asOf: price.asOf,
          });
        }
      }
    }

    if (fiatByCode.size > 0) {
      const { fx } = yield* Oracle;
      const asOf = yield* Clock.currentTimeMillis;
      for (const [code, ticket] of fiatByCode) {
        const rate = yield* fx.resolve(code);
        if (Option.isSome(rate)) {
          out.push({ ticket, unitPrice: rate.value, change24h: null, asOf });
        }
      }
    }

    return out;
  });
