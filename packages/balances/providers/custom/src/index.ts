import {
  type Balance,
  type BalanceProvider,
  buildTokenKey,
  defineProvider,
  type FetchContext,
  type ProviderEntry,
} from "@folio/balances-basic";

// @folio/balances-provider-custom —— 手动资产(manual)。无外部 API:一个账户 = 一个手记资产。
// 三个 public 输入(symbol/amount/unitPrice)走 creds(明文落库、导出原样、可重建);
// fetchBalances map 成单条 Balance:value = amount × unitPrice、price = unitPrice(P7.4.1)。
// `amount` 由 manual 活动账本(manual_activity)推导后【物化】进 creds(见 web server fn);provider 只管读。
// `unitPrice` 用户填(市价自动估值 = P7.4.2)。
// 账户 creds 形状(schema 归 accountType 层;amount/unitPrice 经 z.coerce.number 校验后为 number)。
type ManualCreds = {
  symbol: string;
  amount: number;
  unitPrice: number;
  identifier?: string;
  fixed?: string;
};

export const customProvider = defineProvider({
  accountType: "manual",

  async fetchBalances(ctx: FetchContext<ManualCreds>): Promise<Balance[]> {
    const { symbol, amount, unitPrice, identifier, fixed } = ctx.creds;
    return [
      {
        symbol,
        amount,
        price: unitPrice,
        value: amount * unitPrice,
        kind: "manual" as const,
        // 用户选定的 CGK id = 厂商寻址身份 → tokenKey(coingecko:<id>),不再塞 meta.identifier;
        // 未选币则无标识,解析时按 symbol 归一(同 CEX)。
        ...(identifier ? { tokenKey: buildTokenKey({ cgkId: identifier }) } : {}),
        // meta 只留【行为标志】:fixed(锁定固定值 → sync 期跳过市价重估)。身份不进 meta。
        ...(fixed ? { meta: { fixed: true } } : {}),
      },
    ];
  },

  // 无外部源;账户 creds 已由 accountType 层 validator 校验过 → 恒可用。
  async validateAccount(): Promise<boolean> {
    return true;
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [customProvider];

// 自描述清单(ADR 0009)。手动资产无外部数据源,恒可用。
export const entries: ProviderEntry[] = [
  {
    manifest: {
      id: "manual",
      accountType: "manual",
      dataSource: "none",
      configSchema: [],
      defaultEnabled: true,
    },
    create: () => customProvider,
  },
];
