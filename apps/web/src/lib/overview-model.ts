import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Platforms } from "@folio/platforms";
import type { AssetRef, Tokens } from "@folio/tokens";
import { type OverviewBalance, toAccountSections } from "./account-view";
import { type AggInput, buildCanonicalHoldings } from "./aggregate";
import { tokenLogoUrl } from "./logo";

// 总览读模型(纯 —— 依赖注入,无 cloudflare env,可脱离 server fn 单测)。
// 持仓区 = 跨账户按 canonical 代币聚合(spot/manual/CEX/perp 权益);DeFi 仓位 + perp 敞口走
// 每账户次级分区(不进聚合)。总额 = 各账户最新快照 totalUsd 之和。解析/汇率读时 cache-only。

export interface OverviewDeps {
  tokens: Tokens; // .enrich:tokenKey → group/ref/price(cache-only)
  platforms: Platforms; // .resolve:platform key → name+logo(含兜底)
}

// 从 metaJson 读 perp role(仅判定 equity/position,不做完整窄化)。
function perpRole(metaJson: string | null): "equity" | "position" | null {
  if (!metaJson) return null;
  try {
    const r = (JSON.parse(metaJson) as { role?: unknown }).role;
    return r === "equity" || r === "position" ? r : null;
  } catch {
    return null;
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
    account: { id: string; label: string };
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
  { tokens, platforms }: OverviewDeps,
): Promise<OverviewView> {
  const balancesOf = (id: string) => (byAccount.get(id)?.balances ?? []) as OverviewBalance[];

  // 1) 摊平所有(账户 × 持仓),挑出进聚合的 eligible(spot/manual/perp 权益)并备好 AssetRef。
  const eligible: Elig[] = [];
  for (const account of accounts) {
    for (const b of balancesOf(account.id)) {
      if (b.kind === "spot" || b.kind === "manual") {
        eligible.push({
          account,
          b,
          asset: { symbol: b.symbol, tokenKey: b.tokenKey ?? undefined },
          margin: false,
        });
      } else if (b.kind === "perp" && perpRole(b.metaJson) === "equity") {
        eligible.push({ account, b, asset: { symbol: b.symbol }, margin: true });
      }
    }
  }

  // 2) 富化(附回)→ 组装 AggInput → 聚合。
  const rows = await enrichEligible(eligible, tokens);
  const aggInputs: AggInput[] = rows.map(({ account, b, margin, e }) => ({
    symbol: b.symbol,
    amount: b.amount,
    value: b.usdValue,
    kind: b.kind,
    tokenKey: b.tokenKey,
    isMargin: margin,
    account: { id: account.id, label: account.label, type: account.type, network: account.network },
    group: e?.group,
    ref: e?.ref,
    name: e?.name,
    logo: e ? tokenLogoUrl(e) : undefined, // 上游 URL → folio 代理(隐私;见 ADR 0008)
    change24h: e?.change24h,
  }));
  const holdings = buildCanonicalHoldings(aggInputs);

  // 读路径装饰:每个 platform key 都给一份展示(命中真名+logo,否则兜底名),cache-only 零网络。
  const platformIds = [...new Set(holdings.flatMap((h) => h.sources.map((s) => s.platform.id)))];
  const platformMeta = await platforms.resolve(platformIds);
  for (const h of holdings) {
    for (const s of h.sources) {
      const m = platformMeta.get(s.platform.id);
      if (m) {
        s.platform.name = m.name;
        s.platform.logo = m.logo;
      }
    }
  }

  const holdingsSubtotal = holdings.reduce((sum, h) => sum + h.totalValue, 0);
  const pricesStale = rows.some(({ e }) => e?.priceStale);

  // 3) 次级分区(每账户 defi 分组 + perp 敞口;perp 权益已进 Holdings → 此处只渲染 positions)。
  let defiSubtotal = 0;
  const sections = accounts
    .map((account) => {
      const secs = toAccountSections(balancesOf(account.id));
      defiSubtotal += secs.defi.reduce(
        (s, g) => s + g.rows.reduce((ss, r) => ss + r.usdValue, 0),
        0,
      );
      return {
        account: { id: account.id, label: account.label },
        defi: secs.defi,
        perp: secs.perp,
      };
    })
    .filter((s) => s.defi.length > 0 || (s.perp?.positions.length ?? 0) > 0);

  // 4) 每账户净值(供 ByGroup 标签分组小计)+ 组合总额(按账户去重)。
  const accountTotals = accounts.map((account) => ({
    account: { id: account.id, label: account.label },
    totalUsd: byAccount.get(account.id)?.snapshot.totalUsd ?? 0,
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
