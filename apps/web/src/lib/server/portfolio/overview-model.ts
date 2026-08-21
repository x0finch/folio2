import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { PlatformService, TokenService } from "@folio/oracle";
import { fiatCodeOf, type TokenRecord, type ValuationMode } from "@folio/oracle-basic";
import { Effect } from "effect";
import {
  DEFI_FALLBACK_PROTOCOL,
  defiGainKey,
  type OverviewBalance,
  parseDefiMeta,
  toAccountSections,
} from "@/lib/core/account-view";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { platformLogoUrl, tokenLogoUrl } from "@/lib/core/logo";
import { defiTokenId, refreshableTokenIds } from "@/lib/server/tokens/model";
import { type AggInput, buildCanonicalHoldings } from "./aggregate";
import {
  buildGainLines,
  computeGain24h,
  type Gain,
  type GainCurrentRow,
  type GainHistoryRow,
} from "./gain-24h";
import { deriveLiveAccountTotals, liveValue } from "./live-value";

// 总览读模型(纯 —— 依赖注入,无 cloudflare env,可脱离 server fn 单测)。
// 持仓区 = 跨账户按 canonical 代币聚合(**只认现货** spot/manual/CEX);DeFi 仓位、perp 权益 + 敞口
// 走每账户次级分区(不进聚合)。perp 权益不并入代币聚合(#129:否则它同时落在 Tokens 与 Perps 两个
// tab,小计双算)。总额 = 各账户最新快照 totalUsd 之和。解析/汇率读时 cache-only。

export interface OverviewDeps {
  // 代币富化(`enrich`)与平台展示(`resolve`)不在这里 —— 它们是 `R` 通道上的
  // `TokenService` / `PlatformService`,由调用方一次 `runRequest` 供上。
  // 场馆键(manual/exchange:/perp:)→ 连接器自带 name+logo,不查 CoinGecko(#52);链键返回 null → 走 platforms。
  connectorMeta?: (key: string) => { name: string; logo?: string } | null;
  // 估值模式(Phase 3,#81):读时现推 value 用。缺省 self-first(= 旧行为);per-user 设置接入见 P3-3。
  mode?: ValuationMode;
  // tokenId → 该 token 在 fiat 命名者下的 ref(`fiat/issued:<CODE>`);server 从 token_refs 按 FIAT_NAMER 取。
  // **法币身份不能走 `TokenRecord.ref`**:那条是上游(CGK)那一档,法币没有上游 → 恒 null;且 ADR 0021
  // 把 `ref` 空不空定义成「上游认没认出」,法币借它会被刷价/取价路径误当已收录。故身份单独注入,overview
  // 经 `fiatCodeOf` 判定(白名单校验、**不看裸 symbol**,防 "USD" 撞普通币)。缺省空 → 无法币。
  fiatRefs?: ReadonlyMap<string, string>;
  // 24h 盈亏的原料(ADR 0040):窗口内的余额历史,由调用方按
  // `now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS` 取好传进来。**读 D1 不在这里** —— 这个模块
  // 是纯的(依赖注入、可脱离 server fn 单测),多挂一条 store 依赖会把它拽回 Effect 环境里去。
  // 缺省 → 不算盈亏(字段缺席)。首页总览走这条;独立读取才传入。测试传入则仍走原路径。
  gainHistory?: readonly GainHistoryRow[];
  // 「当下」那一刻。测试注入固定值;生产传 `Date.now()`。分段的末点与容差判定都按它算。
  now?: number;
}

interface Elig {
  account: AccountSafe;
  b: OverviewBalance;
}

// 富化结果**按 token_id 查表**取回。以前是「enrich 返回同序数组 + 下标配对」,那是个长期的
// locality 隐患(克隆/过滤一步就全错位);认定挪到写路径之后,行自己带着 id,配对问题不存在了。

export interface OverviewView {
  holdings: ReturnType<typeof buildCanonicalHoldings>;
  sections: {
    account: { id: string; label: string; platform?: { name: string; logo?: string } };
    defi: ReturnType<typeof toAccountSections>["defi"];
    perp: ReturnType<typeof toAccountSections>["perp"];
  }[];
  accountTotals: {
    account: { id: string; label: string };
    totalUsd: number;
    takenAt: number | null;
  }[];
  totalUsd: number;
  // 组合层 24h 盈亏(ADR 0040)。金额恒等于各 holding 金额之和;百分比是**统一时间轴上的连乘**,
  // 不是各行百分比的任何一种平均 —— 收益率加不起来。null = 一条线都算不出。
  // **可选**:首页总览不再算它(#488 票 5),改走独立读取;测试仍可传入 gainHistory 走这条。
  gain24h?: Gain | null;
  holdingsSubtotal: number;
  defiSubtotal: number;
  pricesStale: boolean;
}

export const buildOverview = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  { connectorMeta, mode = "self-first", fiatRefs, gainHistory, now = Date.now() }: OverviewDeps,
): Effect.Effect<OverviewView, never, TokenService | PlatformService> =>
  Effect.gen(function* () {
    const balancesOf = (id: string) => (byAccount.get(id)?.balances ?? []) as OverviewBalance[];
    // 法币身份:该 token 有 fiat 命名者的 ref、且经 fiatCodeOf 落在白名单内 → 是法币(身份驱动,不看 symbol)。
    const isFiatToken = (tokenId?: string | null): boolean => {
      const ref = tokenId ? fiatRefs?.get(tokenId) : undefined;
      return ref ? fiatCodeOf(ref) != null : false;
    };

    // 1) 摊平所有(账户 × 持仓),挑出进聚合的 eligible —— **只认现货**(spot/manual/CEX/UTXO)。
    // perp 权益、perp 仓位、defi 都不进聚合(#129:perp 权益并入会与 Perps tab 双算),各走次级分区。
    const eligible: Elig[] = [];
    for (const account of accounts) {
      for (const b of balancesOf(account.id)) {
        if (isFungible(viewKind(b))) eligible.push({ account, b });
      }
    }

    // 2) 富化(附回)→ 组装 AggInput → 聚合。
    // 三批 I/O 互相独立(聚合富化 / defi 展示富化 / 每账户现推净值)→ 并行,不再串行叠加
    // 每批的 D1 往返延迟(code review #8)。defi 批只认 tokenRef 明确的行(defiAssetRef 门)。
    const defiFlat = accounts.flatMap((a) =>
      balancesOf(a.id).flatMap((b) => {
        const id = defiTokenId(b);
        return id ? [{ b, id }] : [];
      }),
    );
    // 聚合行与 defi 行的 token_id 合成一批去重后一次读 —— 两处都是「按 id 读整行」,没必要两趟。
    const idsToEnrich = [
      ...new Set([
        ...eligible.flatMap((x) => (x.b.tokenId ? [x.b.tokenId] : [])),
        ...defiFlat.map((x) => x.id),
      ]),
    ];
    const tokens = yield* TokenService;
    const [enriched, liveTotals] = yield* Effect.all(
      [tokens.enrich(idsToEnrich), deriveLiveAccountTotals(accounts, byAccount, mode)],
      { concurrency: 2 },
    );
    const recordOf = (b: { tokenId?: string | null }): TokenRecord | undefined =>
      b.tokenId ? enriched.get(b.tokenId) : undefined;
    const rows = eligible.map((x) => ({ ...x, e: recordOf(x.b) }));
    const aggInputs: AggInput[] = rows.map(({ account, b, e }) => ({
      id: b.id, // 无 token_id 的行按它各自成行(见 aggregate.groupKey)
      // 显示名从 Token 取(#243:快照不再存 symbol)。有 token_id 但上游没认出的行,token 仍带建行时
      // 连接器报的 symbol;压根没有 token_id 的行(仅 v2 导入)没有名字 → 空串,靠上面的 id 保持独立。
      symbol: e?.symbol ?? "",
      amount: b.amount,
      // 读时现推(不落库):按 mode + 实时源价(cache-only)重算 —— self-first 下 enrich-not-reprice
      // 行 ≡ 冻结值,盯市行(manual/bitcoin)取实时源价。aggregate 本身不改,只喂现推后的 value。
      value: liveValue(b, e?.price?.unitPrice, mode),
      kind: viewKind(b), // 归一到 5-kind(并存期兼容遗留)
      platform: b.platform, // provider 直接报的链 ∪ 场馆(#193)
      account: {
        id: account.id,
        label: account.label,
        connectorId: account.connectorId,
        platform: account.platform,
      },
      tokenId: b.tokenId, // **归并键**:写快照时定死(ADR 0021),不再由富化结果反推
      isFiat: isFiatToken(b.tokenId), // 法币身份(#271):稳定占比 + 展示用,身份驱动(见 fiatRefs 注释)
      name: e?.name,
      logo: e ? tokenLogoUrl(e) : undefined, // 上游 URL → folio 代理(隐私;见 ADR 0008)
      change24h: e?.price?.change24h,
      unitPrice: e?.price?.unitPrice, // 详情头部 meta:单价
      marketCapRank: e?.price?.marketCapRank, // 详情头部 meta:市值排名
    }));
    const holdings = buildCanonicalHoldings(aggInputs);

    const withGain = gainHistory != null;
    let portfolioGain: Gain | null | undefined;
    if (withGain) {
      // 24h 盈亏(ADR 0040)。**当下点用现推后的 value**(`aggInputs` 里那个,即首屏显示的市值)——
      // 不用最新快照的冻结值:一天只同步一次时,最后一张快照就是今天零点那张,拿它当末点等于说
      // 「今天一分钱没动」。同一个 `computeGain24h` 既算单行也算组合(#447 第 4 片),所以
      // 「各行相加 = 首页那个数」是结构上成立的,不靠两边各算一遍碰对。
      const currentRows: GainCurrentRow[] = aggInputs.map((r) => ({
        accountId: r.account.id,
        tokenId: r.tokenId ?? null,
        amount: r.amount,
        value: r.value,
      }));
      const gainLines = buildGainLines(gainHistory, currentRows, now);
      for (const h of holdings) {
        // holding.key ≡ aggregate.groupKey ≡ token_id(无 token_id 的旧行各自成行,查不到线 → null)。
        h.gain24h = computeGain24h(gainLines.get(h.key) ?? [], now);
      }
      // 组合层:**同一个函数、喂全部线**。不是把各行的结果再加一遍 —— 金额那样确实等价,但百分比
      // 不行(收益率加不起来,得在统一时间轴上连乘)。一个函数两用,「各行相加 = 首页那个数」于是
      // 是结构上成立的,不靠两边碰对。
      portfolioGain = computeGain24h([...gainLines.values()].flat(), now);
    }

    // 读路径装饰:每个 platform key 都给一份展示(命中真名+logo,否则兜底名),cache-only 零网络。
    // 场馆键(manual/exchange:/perp:)走连接器自带 name+logo,不进 platforms.resolve;只把链键送去查(#52)。
    const platformIds = [...new Set(holdings.flatMap((h) => h.sources.map((s) => s.platform.id)))];
    const chainIds = platformIds.filter((id) => !connectorMeta?.(id));
    const platformMeta = yield* Effect.flatMap(PlatformService, (p) => p.resolve(chainIds));
    for (const h of holdings) {
      for (const s of h.sources) {
        const cm = connectorMeta?.(s.platform.id);
        if (cm) {
          s.platform.name = cm.name;
          s.platform.logo = platformLogoUrl(s.platform.id, cm.logo); // 上游 URL → folio 代理(隐私;ADR 0008)
          continue;
        }
        const m = platformMeta.get(s.platform.id);
        if (m) {
          s.platform.name = m.name;
          s.platform.logo = platformLogoUrl(m.key, m.logo); // 上游 URL → folio 代理(隐私;见 ADR 0008 / #20)
        }
      }
    }

    const holdingsSubtotal = holdings.reduce((sum, h) => sum + h.totalValue, 0);
    // 价 stale = 有价但过期,或**认得出来却压根没价**(新层刚建行时就是这样)→ 客户端触发一次刷新。
    // **只在刷价集合内判脏**(#245:dust 跳过):否则被跳过的 dust 标了脏、刷价那侧(refreshStalePrices
    // 同用 refreshableTokenIds)又不刷 → pricesStale 永清不掉、客户端每次进页空转。与 token-enrich 同门。
    const refreshable = new Set(refreshableTokenIds(rows.map((r) => r.b)));
    const pricesStale = rows.some(
      ({ b, e }) => b.tokenId != null && refreshable.has(b.tokenId) && (e?.price?.stale ?? true),
    );

    // 3) 次级分区(每账户 defi 分组 + perp 权益/敞口)。perp 权益不进 Holdings(#129),只在这里
    // 由 Perps tab 渲染其权益条与仓位。change24h 按行 id 附回(不按对象引用键——那只在 balancesOf
    // 恰好返回同批对象时成立,克隆/规整一步就全落空,code review #9)。
    const defiChange = new Map(defiFlat.map((x) => [x.b.id, enriched.get(x.id)?.price?.change24h]));
    // 每账户明细分区前的富化:① 显示名从 Token 取(#243:快照不再存 symbol)② defi 行附上 24h 涨跌。
    const decorate = (bs: OverviewBalance[]): OverviewBalance[] =>
      bs.map((b) => ({
        ...b,
        symbol: recordOf(b)?.symbol ?? b.symbol,
        ...(defiChange.has(b.id) ? { change24h: defiChange.get(b.id) } : {}),
      }));

    let defiSubtotal = 0;
    const sections = accounts
      .map((account) => {
        const secs = toAccountSections(decorate(balancesOf(account.id)));
        defiSubtotal += secs.defi.reduce(
          (s, g) => s + g.rows.reduce((ss, r) => ss + r.usdValue, 0),
          0,
        );
        // 平台展示(H5 评审:永续节头体现场馆):connectorId 即平台键,连接器 manifest 自带
        // name+logo,logo 走代理(ADR 0008)。无 connectorMeta(测试等)→ undefined,UI 只显账户名。
        const cm = connectorMeta?.(account.connectorId);
        return {
          account: {
            id: account.id,
            label: account.label,
            platform: cm
              ? { name: cm.name, logo: platformLogoUrl(account.connectorId, cm.logo) }
              : undefined,
          },
          defi: secs.defi,
          perp: secs.perp,
        };
      })
      // 仅权益、无持仓的 perp 账户也保留(code review #7):Perps tab 显示其权益条 + 无持仓
      // 文案,权益合计小计才是真「各账户权益合计」。
      .filter(
        (s) =>
          s.defi.length > 0 ||
          (s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null)),
      );

    if (withGain) {
      // —— DeFi 协议行的 24h 盈亏(ADR 0040 的已知妥协)——
      //
      // 这类行没有「几个币」可依,只有一个总价值:两次照片之间价值变了,分不清是市场涨的还是你自己
      // 往里加了钱。所以把每个 (账户 × 协议) 当成**一条数量恒为 1 的线**喂进去 —— 算法于是自动退化
      // 成两张照片的价值相减,不需要第二套逻辑。代价写在明处:你动仓那天这个数不准。
      const defiHistory = gainHistory.filter((r) => r.kind === "defi");
      const defiSlots = new Map<string, { row: GainHistoryRow; gross: number }>();
      for (const r of defiHistory) {
        const protocol = parseDefiMeta(r.metaJson ?? null).protocol ?? DEFI_FALLBACK_PROTOCOL;
        const k = `${defiGainKey(r.accountId, protocol)}|${r.takenAt}`;
        const slot = defiSlots.get(k);
        if (slot) {
          slot.row.usdValue += r.usdValue;
          slot.gross += Math.abs(r.usdValue);
        } else {
          defiSlots.set(k, {
            row: {
              accountId: r.accountId,
              takenAt: r.takenAt,
              tokenId: protocol,
              amount: 1,
              usdValue: r.usdValue,
            },
            gross: Math.abs(r.usdValue),
          });
        }
      }
      const defiGross = new Map<string, { t: number; gross: number }>();
      for (const { row, gross } of defiSlots.values()) {
        const k = defiGainKey(row.accountId, row.tokenId as string);
        const prev = defiGross.get(k);
        if (!prev || row.takenAt < prev.t) defiGross.set(k, { t: row.takenAt, gross });
      }
      const defiCurrent: GainCurrentRow[] = sections.flatMap((s) =>
        s.defi.map((g) => ({
          accountId: s.account.id,
          tokenId: g.protocol,
          amount: 1,
          value: g.rows.reduce((sum, r) => sum + r.usdValue, 0),
        })),
      );
      const defiLines = buildGainLines(
        [...defiSlots.values()].map((x) => x.row),
        defiCurrent,
        now,
        (r) => defiGainKey(r.accountId, r.tokenId),
      );
      for (const s of sections) {
        for (const g of s.defi) {
          const k = defiGainKey(s.account.id, g.protocol);
          const gain = computeGain24h(defiLines.get(k) ?? [], now);
          const gross = defiGross.get(k)?.gross ?? 0;
          g.gain24h =
            gain == null
              ? null
              : {
                  amount: gain.amount,
                  pct: gross > 0 ? (gain.amount / gross) * 100 : null,
                  grossBasis: gross,
                };
        }
      }
    }

    // 4) 每账户净值 + 组合总额(按账户去重)。
    // 现推(不落库,liveTotals 已在步骤 2 并行求得):按当前 mode + 实时源价重算每账户净值,
    // 替代快照冻结 totalUsd。曲线「当下点」复用同一 deriveLiveAccountTotals → 主页总价 ≡ 曲线当下点(#81)。
    const accountTotals = accounts.map((account) => ({
      account: { id: account.id, label: account.label },
      totalUsd: liveTotals.get(account.id) ?? 0,
      takenAt: byAccount.get(account.id)?.snapshot.takenAt ?? null,
    }));
    const totalUsd = accountTotals.reduce((s, r) => s + r.totalUsd, 0);

    return {
      holdings,
      sections,
      accountTotals,
      totalUsd,
      ...(withGain ? { gain24h: portfolioGain } : {}),
      holdingsSubtotal,
      defiSubtotal,
      pricesStale,
    };
  });
