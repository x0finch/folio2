import { PerpEquityMeta } from "@folio/connectors-basic";
import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Platforms } from "@folio/platforms";
import type { AssetRef, Tokens, ValuationMode } from "@folio/tokens";
import { type OverviewBalance, toAccountSections } from "./account-view";
import { type AggInput, buildCanonicalHoldings } from "./aggregate";
import { isFungible, viewKind } from "./balance-kind";
import { deriveLiveAccountTotals, liveValue } from "./live-value";
import { platformLogoUrl, tokenLogoUrl } from "./logo";
import { defiAssetRef } from "./tokens";

// 总览读模型(纯 —— 依赖注入,无 cloudflare env,可脱离 server fn 单测)。
// 持仓区 = 跨账户按 canonical 代币聚合(spot/manual/CEX/perp 权益);DeFi 仓位 + perp 敞口走
// 每账户次级分区(不进聚合)。总额 = 各账户最新快照 totalUsd 之和。解析/汇率读时 cache-only。

export interface OverviewDeps {
  tokens: Tokens; // .enrich:tokenKey → group/ref/price(cache-only)
  platforms: Platforms; // .resolve:platform key → name+logo(含兜底)——仅链键(chain:/eip155:)
  // 场馆键(manual/exchange:/perp:)→ 连接器自带 name+logo,不查 CoinGecko(#52);链键返回 null → 走 platforms。
  connectorMeta?: (key: string) => { name: string; logo?: string } | null;
  // 估值模式(Phase 3,#81):读时现推 value 用。缺省 self-first(= 旧行为);per-user 设置接入见 P3-3。
  mode?: ValuationMode;
}

// perp 权益行只有 meta 可解析才计入聚合 —— 与 toPerpView 的 safeParse 门一致:
// 脏/损坏的遗留 perp 行在明细卡与总额两处都排除,避免"总额算它、明细不显"的不一致
//(承接旧 `perpRole==="equity"` 守卫,守住"单账户脏数据不拖垮总览")。
export function isPerpEquity(metaJson: string | null): boolean {
  if (!metaJson) return false;
  try {
    return PerpEquityMeta.safeParse(JSON.parse(metaJson)).success;
  } catch {
    return false;
  }
}

interface Elig {
  account: AccountSafe;
  b: OverviewBalance;
  asset: AssetRef;
  margin: boolean;
}
type Enrichment = Awaited<ReturnType<Tokens["enrich"]>>[number];
type EnrichedElig = Elig & { e: Enrichment | undefined };

// 一次批量富化,并把结果**附回**每笔 eligible。下标配对只在此一处、紧挨 enrich 调用 ——
// 调用方拿到的是单一自带富化的列表,再也不用维护两个必须同序的并行数组(消除隐性 locality 隐患)。
async function enrichEligible(eligible: Elig[], tokens: Tokens): Promise<EnrichedElig[]> {
  const enriched = await tokens.enrich(eligible.map((x) => x.asset));
  return eligible.map((x, i) => ({ ...x, e: enriched[i] }));
}

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
  holdingsSubtotal: number;
  defiSubtotal: number;
  pricesStale: boolean;
}

export async function buildOverview(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  { tokens, platforms, connectorMeta, mode = "self-first" }: OverviewDeps,
): Promise<OverviewView> {
  const balancesOf = (id: string) => (byAccount.get(id)?.balances ?? []) as OverviewBalance[];

  // 1) 摊平所有(账户 × 持仓),挑出进聚合的 eligible(spot/manual/perp 权益)并备好 AssetRef。
  const eligible: Elig[] = [];
  for (const account of accounts) {
    for (const b of balancesOf(account.id)) {
      const vk = viewKind(b);
      if (isFungible(vk)) {
        // 现货 / UTXO(BTC)→ 进跨账户聚合
        eligible.push({
          account,
          b,
          asset: { symbol: b.symbol, tokenKey: b.tokenKey ?? undefined },
          margin: false,
        });
      } else if (vk === "perp_equity" && isPerpEquity(b.metaJson)) {
        // perp 权益(账户净值载体)→ 进聚合但标 margin;仓位行(perp_position)/ defi 不进。
        // meta 不可解析(脏/损坏遗留行)则排除,与明细卡一致。
        eligible.push({ account, b, asset: { symbol: b.symbol }, margin: true });
      }
    }
  }

  // 2) 富化(附回)→ 组装 AggInput → 聚合。
  // 三批 I/O 互相独立(聚合富化 / defi 展示富化 / 每账户现推净值)→ 并行,不再串行叠加
  // 每批的 D1 往返延迟(code review #8)。defi 批只认 tokenKey 明确的行(defiAssetRef 门)。
  const defiFlat = accounts.flatMap((a) =>
    balancesOf(a.id).flatMap((b) => {
      const ref = defiAssetRef(b);
      return ref ? [{ b, ref }] : [];
    }),
  );
  const [rows, defiEnriched, liveTotals] = await Promise.all([
    enrichEligible(eligible, tokens),
    tokens.enrich(defiFlat.map((x) => x.ref)),
    deriveLiveAccountTotals(accounts, byAccount, tokens, mode),
  ]);
  const aggInputs: AggInput[] = rows.map(({ account, b, margin, e }) => ({
    symbol: b.symbol,
    amount: b.amount,
    // 读时现推(不落库):按 mode + 实时源价(cache-only)重算 —— self-first 下 enrich-not-reprice
    // 行 ≡ 冻结值,盯市行(manual/bitcoin)取实时源价。aggregate 本身不改,只喂现推后的 value。
    value: liveValue(b, e?.unitPrice, mode),
    kind: viewKind(b), // 归一到 5-kind(并存期兼容遗留)
    tokenKey: b.tokenKey,
    isMargin: margin,
    account: {
      id: account.id,
      label: account.label,
      connectorId: account.connectorId,
      network: account.network,
    },
    group: e?.group,
    tokenId: e?.id, // 内部代币行 id → 聚合的 vendor 中立归并键(#73)
    ref: e?.ref,
    name: e?.name,
    logo: e ? tokenLogoUrl(e) : undefined, // 上游 URL → folio 代理(隐私;见 ADR 0008)
    change24h: e?.change24h,
    unitPrice: e?.unitPrice, // 详情头部 meta:单价
    marketCapRank: e?.marketCapRank, // 详情头部 meta:市值排名
  }));
  const holdings = buildCanonicalHoldings(aggInputs);

  // 读路径装饰:每个 platform key 都给一份展示(命中真名+logo,否则兜底名),cache-only 零网络。
  // 场馆键(manual/exchange:/perp:)走连接器自带 name+logo,不进 platforms.resolve;只把链键送去查(#52)。
  const platformIds = [...new Set(holdings.flatMap((h) => h.sources.map((s) => s.platform.id)))];
  const chainIds = platformIds.filter((id) => !connectorMeta?.(id));
  const platformMeta = await platforms.resolve(chainIds);
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
  const pricesStale = rows.some(({ e }) => e?.priceStale);

  // 3) 次级分区(每账户 defi 分组 + perp 敞口;perp 权益已进 Holdings → 此处渲染 positions
  // 与权益)。change24h 按行 id 附回(不按对象引用键——那只在 balancesOf 恰好返回同批对象时
  // 成立,克隆/规整一步就全落空,code review #9)。
  const defiChange = new Map(defiFlat.map((x, i) => [x.b.id, defiEnriched[i]?.change24h]));
  const withDefiChange = (bs: OverviewBalance[]) =>
    bs.map((b) => (defiChange.has(b.id) ? { ...b, change24h: defiChange.get(b.id) } : b));

  let defiSubtotal = 0;
  const sections = accounts
    .map((account) => {
      const secs = toAccountSections(withDefiChange(balancesOf(account.id)));
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

  // 4) 每账户净值(供 ByGroup 标签分组小计)+ 组合总额(按账户去重)。
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
    holdingsSubtotal,
    defiSubtotal,
    pricesStale,
  };
}
