import { env } from "cloudflare:workers";
import type { AssetRef } from "@folio/tokens";
import { createServerFn } from "@tanstack/react-start";
import { type OverviewBalance, toAccountSections } from "../account-view";
import { type AggInput, buildCanonicalHoldings } from "../aggregate";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { buildTokens, enrichBalances } from "./tokens";

// 总览(P2:按代币聚合)。持仓区 = 跨账户按 canonical 代币聚合的 Holdings(spot/manual/CEX/perp 权益);
// DeFi 仓位 + perp 敞口走每账户「DeFi & 永续」次级分区(不进聚合)。总额 = 各账户最新快照 totalUsd 之和。
// 解析读时 cache-only(零网络);perp 权益额外按 symbol 解析并入(ADR-0003,明细标保证金)。

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

export const getMyOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [allAccounts, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    const tokens = buildTokens(env);

    // 1) 摊平所有(账户 × 持仓);挑出进聚合的 eligible(spot/manual/perp 权益)并备好 AssetRef。
    type Elig = {
      account: (typeof accounts)[number];
      b: OverviewBalance;
      asset: AssetRef;
      margin: boolean;
    };
    const eligible: Elig[] = [];
    for (const account of accounts) {
      const bals = (byAccount.get(account.id)?.balances ?? []) as OverviewBalance[];
      for (const b of bals) {
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

    // 2) 一次批量富化(cache-only)→ 组/ref/展示;组装 AggInput → 聚合。
    const enriched = await tokens.enrich(eligible.map((x) => x.asset));
    const aggInputs: AggInput[] = eligible.map((x, i) => {
      const e = enriched[i];
      return {
        symbol: x.b.symbol,
        amount: x.b.amount,
        value: x.b.usdValue,
        kind: x.b.kind,
        tokenKey: x.b.tokenKey,
        isMargin: x.margin,
        account: {
          id: x.account.id,
          label: x.account.label,
          type: x.account.type,
          network: x.account.network,
        },
        group: e?.group,
        ref: e?.ref,
        name: e?.name,
        logo: e?.logo ?? e?.providerLogo,
      };
    });
    const holdings = buildCanonicalHoldings(aggInputs);
    const holdingsSubtotal = holdings.reduce((s, h) => s + h.totalValue, 0);
    const pricesStale = enriched.some((e) => e?.priceStale);

    // 3) 次级分区(每账户 defi 分组 + perp 敞口;perp 权益已进 Holdings → 此处只渲染 positions)。
    let defiSubtotal = 0;
    const sections = accounts
      .map((account) => {
        const bals = (byAccount.get(account.id)?.balances ?? []) as OverviewBalance[];
        const secs = toAccountSections(bals);
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
  });

// 按账户视图(账户页浏览器 + 详情侧栏用):每个活跃账户 + 其最新快照的富化持仓。
// 与 getMyOverview(按代币聚合)分开 —— 账户页是"按账户"的 home,需要每账户明细。
export const getMyAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [allAccounts, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    const tokens = buildTokens(env);
    const rows = await Promise.all(
      accounts.map(async (account) => {
        const latest = byAccount.get(account.id);
        const enriched = await enrichBalances(tokens, latest?.balances ?? []);
        return {
          account: { id: account.id, label: account.label },
          totalUsd: latest?.snapshot.totalUsd ?? 0,
          takenAt: latest?.snapshot.takenAt ?? null,
          balances: enriched.rows,
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    return { rows, pricesStale: rows.some((r) => r.pricesStale) };
  });
