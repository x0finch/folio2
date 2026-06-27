import { env } from "cloudflare:workers";
import { listSnapshotTotalsByUser } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { buildPortfolioHistory } from "../history";
import { requireAuth } from "../require-auth";

// 组合净值历史:全部快照总额 → 阶梯式重建为时间序列(纯函数,可序列化输出)。
// 序列 { t, total }[] 是可 JSON 序列化的纯数字,故在 server fn 内构建后直接返回。
export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const rows = await listSnapshotTotalsByUser(env, context.userId);
    return { series: buildPortfolioHistory(rows) };
  });
