import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isFungible, viewKind } from "../balance-kind";
import { isPerpEquity } from "../overview-model";
import { buildTokenValueHistory, type TokenHistRow } from "../token-history";
import { db } from "./internal/db";
import { requireAuth } from "./internal/require-auth";

// 单币持仓价值历史(H6 片2):某持仓(按 Holding key = token_id)的价值随时间。
// 全历史余额 → 按 eligibility 过滤(与 overview-model 同口径:现货 / meta 可解析的 perp 权益保证金)
// → buildTokenValueHistory 归属 + 跨账户阶梯重建。过去点用冻结 usd_value(不现推);since 裁窗口。
//
// **不再富化**(ADR 0021 / #201):身份在写快照时就冻进行里了,历史行自己带着 token_id。
// 以前这里要把几千条历史行整批 enrich 一遍才知道它们是哪个币 —— 那一趟 D1 往返整个消失。
export const getHoldingHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ key: z.string().min(1), since: z.number().int().nonnegative().optional() }))
  .handler(async ({ data, context }) => {
    const rows = await db.listSnapshotBalancesByUser(context.userId, data.since);
    // eligibility + asset 构造均与 overview-model 一致:现货带 tokenRef(懒解析更准),perp 权益仅 symbol。
    const eligible = rows.filter((r) => {
      const vk = viewKind(r);
      return isFungible(vk) || (vk === "perp_equity" && isPerpEquity(r.metaJson));
    });
    const histRows: TokenHistRow[] = eligible.map((r) => {
      const vk = viewKind(r);
      return {
        symbol: r.symbol,
        amount: r.amount,
        value: r.usdValue, // 冻结口径(过去点用当时快照值,不现推)
        kind: vk,
        isMargin: vk === "perp_equity",
        account: { id: r.accountId, label: "", connectorId: "" }, // groupKey 只用 account.id
        tokenId: r.tokenId,
        takenAt: r.takenAt,
      };
    });
    return { series: buildTokenValueHistory(histRows, data.key) };
  });
