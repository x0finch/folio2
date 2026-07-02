import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { buildTokens, enrichBalances } from "./tokens";

// 总览:把每个账户与其最新快照合并。从未同步的账户也列出(totalUsd 0、无明细)。
// 总额 = 各账户最新快照 totalUsd 之和(按账户去重,不重复累加)。
// balances 经代币参考层 cache-only 富化(name/logo/unitPrice/change24h;缺则降级),零网络;
// 预热由 sync/cron 后台写缓存(见 server/tokens.ts)。usdValue 不重算(provider 仍是加总权威)。
export const getMyOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    const tokens = buildTokens(env);

    const rows = await Promise.all(
      accounts.map(async (account) => {
        const latest = byAccount.get(account.id);
        return {
          account,
          totalUsd: latest?.snapshot.totalUsd ?? 0,
          takenAt: latest?.snapshot.takenAt ?? null,
          // metaJson 仍原样带过线(perp 的 metaJson→视图解析在纯函数 toPerpView);
          // 富化字段(name/logo/unitPrice/change24h)由 enrichBalances 挂上(JSON 可序列化)。
          balances: await enrichBalances(tokens, latest?.balances ?? []),
        };
      }),
    );
    const totalUsd = rows.reduce((sum, r) => sum + r.totalUsd, 0);
    return { rows, totalUsd };
  });
