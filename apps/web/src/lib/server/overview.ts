import { env } from "cloudflare:workers";
import { getLatestSnapshotByUser, listAccountsByUser } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 总览:把每个账户与其最新快照合并。从未同步的账户也列出(totalUsd 0、无明细)。
// 总额 = 各账户最新快照 totalUsd 之和(按账户去重,不重复累加)。
export const getMyOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, snapshots] = await Promise.all([
      listAccountsByUser(env, context.userId),
      getLatestSnapshotByUser(env, context.userId),
    ]);
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));

    const rows = accounts.map((account) => {
      const latest = byAccount.get(account.id);
      return {
        account,
        totalUsd: latest?.snapshot.totalUsd ?? 0,
        takenAt: latest?.snapshot.takenAt ?? null,
        // balances 原样带 metaJson 过线(JSON 字符串,可序列化);perp 的 metaJson→视图
        // 解析集中在纯函数 toPerpView 里(一处、可测),组件保持纯展示。
        balances: latest?.balances ?? [],
      };
    });
    const totalUsd = rows.reduce((sum, r) => sum + r.totalUsd, 0);
    return { rows, totalUsd };
  });
