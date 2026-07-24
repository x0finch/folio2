import type { AssetRef } from "@folio/tokens";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isFungible, viewKind } from "../balance-kind";
import { isPerpEquity } from "../overview-model";
import { buildTokenValueHistory, type TokenHistRow } from "../token-history";
import { db } from "./internal/db";
import { oracle } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

// 单币持仓价值历史(H6 片2):某持仓(按 Holding key)的价值随时间。全历史余额 → 按 eligibility 过滤
// (与 overview-model 同口径:现货 / meta 可解析的 perp 权益保证金)→ 富化解析代币身份 →
// buildTokenValueHistory 归属 + 跨账户阶梯重建。过去点用冻结 usd_value(不现推);since 裁窗口。
export const getHoldingHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ key: z.string().min(1), since: z.number().int().nonnegative().optional() }))
  .handler(async ({ data, context }) => {
    const rows = await db.listSnapshotBalancesByUser(context.userId, data.since);
    // eligibility + asset 构造均与 overview-model 一致:现货带 tokenKey(懒解析更准),perp 权益仅 symbol。
    const eligible = rows.filter((r) => {
      const vk = viewKind(r);
      return isFungible(vk) || (vk === "perp_equity" && isPerpEquity(r.metaJson));
    });
    const assets: (AssetRef | null)[] = eligible.map((r) =>
      viewKind(r) === "perp_equity"
        ? { symbol: r.symbol }
        : { symbol: r.symbol, tokenKey: r.tokenKey ?? undefined },
    );
    const enriched = await oracle.tokens.enrich(assets);
    const histRows: TokenHistRow[] = eligible.map((r, i) => {
      const e = enriched[i];
      const vk = viewKind(r);
      return {
        symbol: r.symbol,
        amount: r.amount,
        value: r.usdValue, // 冻结口径(过去点用当时快照值,不现推)
        kind: vk,
        tokenKey: r.tokenKey,
        isMargin: vk === "perp_equity",
        account: { id: r.accountId, label: "", connectorId: "" }, // holdingKey 只用 account.id
        group: e?.group,
        tokenId: e?.id,
        ref: e?.ref,
        takenAt: r.takenAt,
      };
    });
    return { series: buildTokenValueHistory(histRows, data.key) };
  });
