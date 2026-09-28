import type { Balance } from "@folio/connectors-basic";
import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { fiatCodeOf, type ValuationMode, valuate } from "@folio/oracle-basic";
import { Effect, Option } from "effect";

// 写快照前的估值(oracle 多源,Phase 3)。对每笔持仓:
//   · 非盯市类型 → 捕获 selfPrice(自带单价 = price ?? value/amount),作估值「原料」随 balance 落快照;
//     盯市类型无权威自带价 → selfPrice = undefined(恒用源价)。
//   · 按 mode 用 valuate 定 value/price:self-first(默认)有自带用自带、无则源价补;source-first 反之;
//     都无 → 保留 provider 原值。
// 「是否盯市」由 connector 的 manifest.valuation 决定,调用方(sync-deps)解析后以 `markToMarket` 布尔注入
//(不再靠 app 侧硬编码名单;第三方 connector 自带该语义 —— 见 @folio/connectors-basic ConnectorValuation)。
// 源价仅在需要时取(self-first 且无自带价 / source-first 恒取)—— self-first 下 CEX 有自带价即不查价。
// 只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。mode 由调用方按 per-user 设置注入,缺省 self-first。
//
// **源价只读价表,不出网**(FOL-87)。以前每笔要源价的持仓调一次 `priceOf`(SWR:stale 就当场回源),
// 并发无上限、不成批 —— 价 TTL 30 分钟、同步每小时一次,所以几乎每次同步都是「每个币一发 CoinGecko」,
// 一条 `sync-account` 消息的 50 发预算被持仓数直接吃穿。现在:要源价的 id 先收齐,`pricesOf` 一次批读
// 价表;表里的价由队列的 `prices` 活每小时整批刷(见 `jobs/prices.ts`)。
//
// **代价(收下的)**:同一小时里 `prices` 与 `sync-account` 并发投、谁先跑不定,所以这一轮的快照可能
// 用的是上一轮刷的价 —— 最多约一小时旧(stale 的也照用,不回退)。不按顺序排(比如让同步延后投)是因为
// 延后的是用户看得见的同步进度;而价旧一小时只影响写进快照的那一格 value,展示层本来就按价表现价重算。
// 表里连旧价都没有(新币第一次出现)→ 退回自带价 / provider 原值(`valuate` 的规则),下一轮 `prices`
// 会把它补上。
//
// **身份从 `idByRef` 来,不在这里解析**(#202)。以前这里调 `tokens.resolve({symbol, tokenRef})` ——
// 那是读时解析的最后一处残留:同一笔持仓的身份在写路径上被算了两遍(revalue 一次、写快照一次),
// 而且两遍中间有别的账户在并发建行,答案可能不一致。现在 mint 在上一步跑完、把答案传下来。
// **法币分支**(ADR 0025):某笔持仓身份是 `fiat/issued:<CODE>` 时,USD 值 = 数量 × FX 汇率
// (`usd_per_unit`,USD 恒 1),**每次现算、不冻 selfPrice** —— 与 manual mark-to-market 一致:
// 汇率变则非美元法币的 USD 显示值随之变。取价与汇率两样能力都在 `R` 通道上(聚合 `Oracle`),
// 由调用方那一次装配供上 —— 这个函数自己不建任何门面。
// 汇率缺失(非美元且缓存冷)→ 保留 provider 原值(best-effort,不抛)。
//
// 逐笔那一步现在只剩法币的 `fx.resolve`(读缓存)与纯计算,并发度仍是 `unbounded`。
export const revalue = (
  markToMarket: boolean,
  balances: Balance[],
  idByRef: ReadonlyMap<string, string>,
  mode: ValuationMode = "self-first",
): Effect.Effect<Balance[], never, Oracle | DbRequest> =>
  Effect.gen(function* () {
    const { tokens, fx } = yield* Oracle;

    // 盯市类型无权威自带价 → selfPrice = undefined(恒用源价);否则自带单价 = price ?? value/amount。
    const selfPriceOf = (b: Balance): number | undefined =>
      markToMarket
        ? undefined
        : (b.price ?? (b.amount > 0 && b.value > 0 ? b.value / b.amount : undefined));
    // 这笔要不要源价、要的话是哪个 token_id(认不出来的币 mint 没给 id → 拿不到源价,不猜)。
    const sourceIdOf = (b: Balance): string | undefined => {
      if (b.kind === "perp_position" || b.kind === "perp_equity") return undefined;
      if (b.tokenRef && fiatCodeOf(b.tokenRef)) return undefined;
      // self-first 且已有自带价 → 无需源价(CEX 不查价);否则要。
      if (mode !== "source-first" && selfPriceOf(b) != null) return undefined;
      return b.tokenRef ? idByRef.get(b.tokenRef) : undefined;
    };

    // **一次批读**,不是逐笔点查。
    const wanted = [...new Set(balances.map(sourceIdOf).filter((id) => id !== undefined))];
    const sourcePrices = yield* tokens.pricesOf(wanted);

    return yield* Effect.forEach(
      balances,
      (b) =>
        Effect.gen(function* () {
          // 永续行的 value 不是「数量 × 单价」,不能按市价重估(否则仓位被算成 数量×币价 的巨额名义值,
          // 污染净值 —— 见 P5.1):perp_position 恒 0(名义敞口在 meta)、perp_equity = 账户净值(provider 给)。
          // 保留 provider 原值,不解析币价、不设 selfPrice。
          if (b.kind === "perp_position" || b.kind === "perp_equity") return b;

          // 法币:USD 值 = 数量 × 汇率(USD=1),现算不冻价。取不到汇率 → 保留 provider 原值,不抛。
          const fiatCode = b.tokenRef ? fiatCodeOf(b.tokenRef) : undefined;
          if (fiatCode) {
            const usdPerUnit = yield* fx.resolve(fiatCode);
            if (Option.isNone(usdPerUnit)) return b;
            return {
              ...b,
              price: usdPerUnit.value,
              value: b.amount * usdPerUnit.value,
            };
          }

          const selfPrice = selfPriceOf(b);
          const sourceId = sourceIdOf(b);
          const sourcePrice = sourceId ? sourcePrices.get(sourceId)?.unitPrice : undefined;
          const v = valuate(b.amount, selfPrice, sourcePrice, mode);
          return v ? { ...b, selfPrice, price: v.unitPrice, value: v.value } : { ...b, selfPrice };
        }),
      { concurrency: "unbounded" },
    );
  });
