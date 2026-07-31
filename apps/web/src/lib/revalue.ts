import type { Balance } from "@folio/connectors-basic";
import type { FxRates, Tokens } from "@folio/oracle";
import { fiatCodeOf, type ValuationMode, valuate } from "@folio/oracle-basic";

// 写快照前的估值(oracle 多源,Phase 3)。对每笔持仓:
//   · 非盯市类型 → 捕获 selfPrice(自带单价 = price ?? value/amount),作估值「原料」随 balance 落快照;
//     盯市类型无权威自带价 → selfPrice = undefined(恒用源价)。
//   · 按 mode 用 valuate 定 value/price:self-first(默认)有自带用自带、无则源价补;source-first 反之;
//     都无 → 保留 provider 原值。
// 「是否盯市」由 connector 的 manifest.valuation 决定,调用方(sync-deps)解析后以 `markToMarket` 布尔注入
//(不再靠 app 侧硬编码名单;第三方 connector 自带该语义 —— 见 @folio/connectors-basic ConnectorValuation)。
// 源价仅在需要时取(self-first 且无自带价 / source-first 恒取)—— self-first 下 CEX 有自带价即不回源,
// 与旧行为同开销、同结果。只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。mode 由调用方按 per-user 设置注入,缺省 self-first。
//
// **身份从 `idByRef` 来,不在这里解析**(#202)。以前这里调 `tokens.resolve({symbol, tokenRef})` ——
// 那是读时解析的最后一处残留:同一笔持仓的身份在写路径上被算了两遍(revalue 一次、写快照一次),
// 而且两遍中间有别的账户在并发建行,答案可能不一致。现在 mint 在上一步跑完、把答案传下来。
// **法币分支**(ADR 0025):某笔持仓身份是 `fiat/issued:<CODE>` 时,USD 值 = 数量 × FX 汇率
// (`usd_per_unit`,USD 恒 1),**每次现算、不冻 selfPrice** —— 与 manual mark-to-market 一致:
// 汇率变则非美元法币的 USD 显示值随之变。FX 能力经 `fx`(`oracleFor(userId).fx`)注入,与 `tokens`
// 一样由 app 编排层给,纯函数里不 new 门面。汇率缺失(非美元且缓存冷)→ 保留 provider 原值(best-effort,不抛)。
export async function revalue(
  tokens: Tokens,
  fx: FxRates,
  markToMarket: boolean,
  balances: Balance[],
  idByRef: ReadonlyMap<string, string>,
  mode: ValuationMode = "self-first",
): Promise<Balance[]> {
  return Promise.all(
    balances.map(async (b) => {
      // 永续行的 value 不是「数量 × 单价」,不能按市价重估(否则仓位被算成 数量×币价 的巨额名义值,
      // 污染净值 —— 见 P5.1):perp_position 恒 0(名义敞口在 meta)、perp_equity = 账户净值(provider 给)。
      // 保留 provider 原值,不解析币价、不设 selfPrice。
      if (b.kind === "perp_position" || b.kind === "perp_equity") return b;

      // 法币:USD 值 = 数量 × 汇率(USD=1),现算不冻价。取不到汇率 → 保留 provider 原值,不抛。
      const fiatCode = b.tokenRef ? fiatCodeOf(b.tokenRef) : undefined;
      if (fiatCode) {
        const usdPerUnit = await fx.resolve(fiatCode);
        if (usdPerUnit == null) return b;
        return { ...b, price: usdPerUnit, value: b.amount * usdPerUnit };
      }

      const selfPrice = markToMarket
        ? undefined
        : (b.price ?? (b.amount > 0 && b.value > 0 ? b.value / b.amount : undefined));
      // self-first 且已有自带价 → 无需源价(与旧行为同:CEX 不回源);否则取源价。
      const needSource = mode === "source-first" || selfPrice == null;
      let sourcePrice: number | undefined;
      if (needSource) {
        // 认不出来的币(mint 没给出 id)拿不到源价 —— 退回自带价 / provider 原值,不猜。
        const tokenId = b.tokenRef ? idByRef.get(b.tokenRef) : undefined;
        if (tokenId) sourcePrice = (await tokens.priceOf(tokenId))?.unitPrice;
      }
      const v = valuate(b.amount, selfPrice, sourcePrice, mode);
      return v ? { ...b, selfPrice, price: v.unitPrice, value: v.value } : { ...b, selfPrice };
    }),
  );
}
