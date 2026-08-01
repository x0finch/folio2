import { fiatCodeOf, type TokenRef, tokenTicket } from "@folio/oracle";

// 选币的「一批票 → 价」分流(#202b 三个选币 server fn 里那段的共同芯)。**两条路**:
//   · 法币 —— 代币价格源里没有它的价,走 FX 现汇(USD 恒 1、其余当天汇率、无 24h 涨跌;ADR 0025)。
//   · 其余 —— 走代币价格源(pricesByRefs)。
// 判据是 `fiatCodeOf`:命中白名单法币 → 走 FX;白名单外的 `fiat/issued:XXX` 落回代币源(拿不到价而已)。
//
// 取数全靠注入 —— server fn 各自给真 oracle(fx / tokens 门面),测试给假的。本函数只干三件与网络无关的事:
// **解票 → 按 fiatCodeOf 分流 → 拼回票**。所以它是纯逻辑、可单测,而两个 server fn 从此共用同一段、
// 只差「批量刷价 warm 一次 / 单条预填不 warm」这一个注入点。

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

export interface PriceTicketsDeps {
  // 放行的命名者集合(当前代币上游 + `fiat`)。别家命名者的票解不开 → 丢弃(#223 同款自证)。
  namers: readonly string[];
  // 法币现汇:code(大写)→ usdPerUnit。USD 恒 1;取不到(FX 冷且非 USD)→ undefined(该票降级、不出现)。
  resolveFiat: (code: string) => Promise<number | undefined>;
  // 命中的法币先暖一次(可选)—— 批量刷价传它(冷则一把拉全),单条预填不传(靠 loader 已暖的缓存)。
  warmFiat?: (codes: readonly string[]) => Promise<void>;
  // 代币价格源(批量按 ref 现取,不建行不写缓存)。未收录的 ref 不在结果里。
  priceCrypto: (refs: readonly TokenRef[]) => Promise<ReadonlyMap<TokenRef, TickerPrice>>;
  now: () => number;
}

export async function priceTickets(
  tickets: readonly string[],
  deps: PriceTicketsDeps,
): Promise<PricedTicket[]> {
  // 票 → ref(解不开 / 别家命名者的丢掉),并记 ref→票 好把结果映射回票。同一 ref 的重复票收敛成一条。
  const byRef = new Map<TokenRef, string>();
  for (const ticket of tickets) {
    const ref = tokenTicket.decode(ticket, deps.namers);
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
    const priced = await deps.priceCrypto(cryptoRefs);
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
    await deps.warmFiat?.([...fiatByCode.keys()]);
    const asOf = deps.now();
    for (const [code, ticket] of fiatByCode) {
      const rate = await deps.resolveFiat(code);
      if (rate != null) out.push({ ticket, unitPrice: rate, change24h: null, asOf });
    }
  }

  return out;
}
