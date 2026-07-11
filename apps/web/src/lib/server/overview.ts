import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { buildOverview } from "../overview-model";
import { requireAuth } from "../require-auth";
import { connectorPlatformMeta } from "./connector-platform";
import { db } from "./db";
import { buildPlatforms } from "./platforms";
import { buildTokens, enrichBalances } from "./tokens";

// 总览(P2:按代币聚合)。装配逻辑在纯模块 ../overview-model(buildOverview);此处只做
// 鉴权 + 加载(accounts / 最新快照)+ 注入依赖(tokens / platforms)+ 调用。
export const getMyOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [allAccounts, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const accounts = allAccounts.filter((a) => a.archivedAt == null);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    return buildOverview(accounts, byAccount, {
      tokens: buildTokens(env),
      platforms: buildPlatforms(env),
      connectorMeta: connectorPlatformMeta,
    });
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
          // note 重设计(两级):① balance 级单个 note 随各 balance 透传(db 已把 snapshot_balances.note
          // safeParse 成 Note),现货行副行渲染 <NoteBadge>;② account 级 note(Note[],整钱包,BTC 未确认/
          // 收款/派生分布)是每账户一份,db 已 safeParse 成 Note[],这里随 row.note 带出 → 持仓区手风琴。
          note: latest?.note,
          balances: enriched.rows,
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    return { rows, pricesStale: rows.some((r) => r.pricesStale) };
  });
