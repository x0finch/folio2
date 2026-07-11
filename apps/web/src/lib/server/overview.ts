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
          balances: enriched.rows,
          // 账户级展示明细(DetailBlock 重设计):从账户快照 detail 读出(已 safeParse 成 DetailSection[])。
          detail: latest?.detail ?? [],
          pricesStale: enriched.pricesStale,
        };
      }),
    );
    return { rows, pricesStale: rows.some((r) => r.pricesStale) };
  });
