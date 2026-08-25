import type { Gain } from "./gain-24h";

// symbol 归一(与 tokens 层同口径:trim + 大写)—— 只用在还没有 token_id 的行上(见 groupKey)。
const norm = (s: string): string => s.trim().toUpperCase();

// 纯逻辑(无 server-only import → 可单测)。把跨账户的持仓行按【规范代币】聚合成 Holding 树。
// 设计见 docs/adr 0001–0003;术语见 CONTEXT.md。
//   · 白名单(进聚合):spot / utxo(BTC)/ CEX 现货(kind=spot)—— **只认现货**。perp 权益不并入
//     (#129:并入会让它同时出现在 Tokens 与 Perps 两个 tab,小计双算、三 tab 加起来 ≠ 顶部)。ADR-0003。
//     kind 已由 overview 用 viewKind 归一。
//   · **归并键就是 `token_id`**(ADR 0021 / #201)。认定在写快照时已经定死(mint),读端不再解析、
//     不再有「三级回退」——「永不裸 symbol」(ADR-0002)因此不是一条要维护的规则,而是结构使然。
//     展示分组那一级已随 ADR 0021 退场 —— WBTC 与 BTC、USDT 各桥接变体从此各占一行。
//   · HoldingSource 粒度 = 账户 × 平台单元:平台由 provider 随余额直接报(ADR 0021),链上按链天然拆开。
//   · 表头 totalAmount = 组内各 source 数量之和。组 = 同一个 Token(单位一致),跨链/多源(同一 Token
//     的多条链 ref)亦可汇总。**一组恒是一个 Token**,所以 change24h 无条件给 —— 以前那个
//     「组内是否单一身份」的 Set 判断已随三级键一并删除(键塌成一级后它恒为 1,是死逻辑)。

// 聚合输入:一笔持仓 + 其解析结果(ref/展示,由 server 富化)。
export interface AggInput {
  id?: string; // 余额行 id;仅用作没有 token_id 的行的稳定分组键(见 groupKey)
  symbol: string;
  amount: number;
  value: number; // USD(provider 权威;聚合按它求和)
  kind: string; // 归一后的 viewKind:spot | defi | perp_equity | perp_position | utxo
  // 这笔持仓所在的链 ∪ 场馆,provider 直接报(#193)。本列之前写下的旧快照行为空 → 退回账户的
  // connectorId(多链钱包会暂时并成一格,下次同步即分开)。
  platform?: string | null;
  account: { id: string; label: string; connectorId: string; platform?: string | null };
  // **归并身份**:写快照时 mint 定死的代币行 id(ADR 0021)。
  // 可空只为兼容两类行:本列之前写下的旧快照,以及手记那种现造的持仓(#203 并入 tokens 后就没了)。
  tokenId?: string | null;
  name?: string;
  logo?: string; // 已按回退链取好(CGK→provider)
  // 法币身份(ADR 0025 / #271):由该 token 在 fiat 命名者下的 ref 经 fiatCodeOf 推出(server 富化处算)。
  // 一组 = 一个 token_id → 组内 isFiat 一致,取代表值即可。稳定占比据此把法币算稳定(见 hero-stats)。
  isFiat?: boolean;
  change24h?: number; // 每币 24h 涨跌(%);仅单 Token 组用于行内 ValueChange
  unitPrice?: number; // 单价(USD;展示用,详情头部)
  marketCapRank?: number; // 市值排名(展示用,详情头部)
}

export interface HoldingSource {
  platform: { id: string; name: string; logo?: string };
  account: { id: string; label: string };
  amount: number;
  value: number;
  kind: string;
}
export interface Holding {
  key: string; // 分组键(去重/稳定用)
  // unitPrice/marketCapRank:详情头部 meta 展示用,取代表行(a.first);缺则不显。
  token: {
    id?: string;
    symbol: string;
    name: string;
    logo?: string;
    unitPrice?: number;
    marketCapRank?: number;
    isFiat?: boolean; // 法币身份(ADR 0025);组 = 一个 token → 取组内代表值。
  };
  totalValue: number;
  totalAmount?: number; // 各 source 数量之和(组统一单位,跨链/多源亦可汇总)
  change24h?: number; // 仅单一 Token 组(%,每币 CGK 涨跌)
  // 24h 盈亏(ADR 0040):由 server 读路径(buildOverview)按快照历史分段算好后附上,**不在这里算** ——
  // 聚合只负责归并,盈亏要的原料(历史)不在它手上。`null` = 算不出(缺基准),`undefined` = 这条路
  // 没接盈亏(账户抽屉那条路暂时如此,见 #447 第 5 片)。
  gain24h?: Gain | null;
  sources: HoldingSource[];
}

// 分组键 = `token_id`。以前这里有个三级回退的 `holdingKey`(token → tokenRef → account:symbol),
// 随认定挪到写路径一并塌成一级 —— 那个函数已删,单币历史(token-history)直接按 token_id 匹配。
//
// 还留一条兜底:没有 token_id 的行**各自成行**,键 = `账户 + 余额行 id`。够得到这条的只有导入进来
// 的 v2 旧行(sync 恒经 mint 定死 token_id;#243 删了 symbol 列后这类行也没名字可归并了)。
// 键带**余额行 id** 而非 symbol —— symbol 已不在行上,再拿它当键会让一个账户里所有无 token 的行
// 塌成一条空名持仓、金额被错误相加(裸 symbol 归并本就是 ADR-0002 的红线)。带账户 id 兼防跨账户混。
// id 缺席(历史行不带)→ 回落空 symbol,那条恒不匹配任何真 token_id 键,只会被 token-history 排除。
export function groupKey(row: AggInput): string {
  return row.tokenId ?? `no-token:${row.account.id}:${row.id ?? norm(row.symbol)}`;
}

// 导出供 token-history 复用(历史行归属同一口径)。
export function isEligible(row: AggInput): boolean {
  // 进聚合的同质口径:只认现货(含并回的 BTC)。perp 权益不并入(#129:避免与 Perps tab 双算,
  // 让三 tab 小计可相加)。kind 已由 overview 用 viewKind 归一。
  return row.kind === "spot";
}

interface Acc {
  key: string;
  first: AggInput;
  totalValue: number;
  totalAmount: number;
  logoHint?: string; // 首个带 logo 的成员(a.first 富化未命中时兜底,与 unitPriceHint 同理)
  // 首个带价/排名的成员(组统一资产 → 单价一致):多源组里 a.first 可能是未定价的桥接/孤儿变体,
  // 取「首个有值」而非 a.first,避免头部价格/排名随行序偶发隐藏(与 logoHint 同理)。
  unitPriceHint?: number;
  marketCapRankHint?: number;
  // 持有点按 (account, platform) 去重合并(红线 3:同地址双 provider 覆盖)。
  sources: Map<string, HoldingSource>;
}

// 聚合器:eligible 行 → 按代币的 Holding[]。value 降序;组内单一 Token 才给 totalAmount。
export function buildCanonicalHoldings(rows: readonly AggInput[]): Holding[] {
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    if (!isEligible(row)) continue;
    const key = groupKey(row);
    let a = acc.get(key);
    if (!a) {
      a = {
        key,
        first: row,
        totalValue: 0,
        totalAmount: 0,
        sources: new Map(),
      };
      acc.set(key, a);
    }
    a.totalValue += row.value;
    a.totalAmount += row.amount;
    if (!a.logoHint && row.logo) a.logoHint = row.logo;
    if (a.unitPriceHint == null && row.unitPrice != null) a.unitPriceHint = row.unitPrice;
    if (a.marketCapRankHint == null && row.marketCapRank != null)
      a.marketCapRankHint = row.marketCapRank;
    // 持有点的平台单元:链上按链拆(同账户多链 → 多 source),场馆/manual 即连接器本身
    // (name+logo 读路径取连接器自带,#53)。平台由 provider 报,不再从 tokenRef 反推。
    const platformId = row.platform ?? row.account.connectorId;
    const sk = `${row.account.id}|${platformId}`;
    const existing = a.sources.get(sk);
    if (existing) {
      existing.amount += row.amount;
      existing.value += row.value;
    } else {
      a.sources.set(sk, {
        // name = key 占位;真名 + logo 由 server 读路径 platforms.resolve 装饰(每个 key 必有兜底)。
        platform: { id: platformId, name: platformId },
        account: { id: row.account.id, label: row.account.label },
        amount: row.amount,
        value: row.value,
        kind: row.kind,
      });
    }
  }

  const holdings: Holding[] = [];
  for (const a of acc.values()) {
    // 无美元价值(未定价/垃圾空投)→ 不进组合持仓:对净值无贡献,却会污染值排序、best/worst
    // 24h 择取(deriveHeroMetrics 只看 change24h,不看 value)与列表(挤满小额)。账户详情走
    // toAccountSections 原始余额,仍保留这些行 —— 此处只清「按代币的组合视角」。
    //
    // **判据是「等于 0」,不是「≤ 0」**(#527 发现 2):负合计的行**要留** —— perp 亏穿时那笔
    // 是真实持仓,而 `totalUsd` 从来都算着它。原来写 `<= 0`,于是屏幕上总额少了一截、列表里
    // 却没有任何一行能解释它去哪了 ——「总额和明细对不上」是最招人怀疑数据错了的那种不一致。
    if (a.totalValue === 0) continue;
    const sources = [...a.sources.values()].sort((x, y) => y.value - x.value);
    const token = {
      id: a.first.tokenId ?? undefined,
      symbol: a.first.symbol,
      name: a.first.name ?? a.first.symbol,
      logo: a.first.logo ?? a.logoHint,
    };
    holdings.push({
      key: a.key,
      token: {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        logo: token.logo,
        // 价/排名取组内「首个有值」(见 unitPriceHint 注释):组统一单位 → 单价一致,不依赖行序。
        unitPrice: a.unitPriceHint,
        marketCapRank: a.marketCapRankHint,
        // 组 = 一个 token_id → isFiat 组内一致,取代表行(a.first)即可。
        isFiat: a.first.isFiat,
      },
      totalValue: a.totalValue,
      totalAmount: a.totalAmount, // 组 = 同一资产、统一单位 → 各 source 数量之和恒可汇总
      change24h: a.first.change24h,
      sources,
    });
  }
  return holdings.sort((x, y) => y.totalValue - x.totalValue);
}
