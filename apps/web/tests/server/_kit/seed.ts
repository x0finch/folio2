import type { ConnectorId } from "@folio/connectors";
import type { AccountSafe } from "@folio/db";
import { db } from "./db";

// **造数据。** 读模型那一片的用例几乎都要「账户 + 快照」这两样,写法散在各文件里会慢慢长歪 ——
// 而它们一歪,断言的就不是同一个场景了。

export const seedAccount = (
  userId: string,
  label: string,
  connectorId: ConnectorId = "manual",
): Promise<AccountSafe> => db(userId).accounts.create({ connectorId, label, creds: null });

export interface BalanceSpec {
  readonly tokenId: string;
  readonly amount: number;
  readonly usdValue: number;
  readonly kind?: "spot" | "defi" | "perp_equity" | "perp_position";
  readonly platform?: string;
  readonly selfPrice?: number;
  readonly meta?: Record<string, unknown>;
}

/**
 * 给账户落一张快照。
 *
 * `takenAt` 必须显式给:这一片的用例大半是「两天前和现在」「24 小时前的基准」这种时间关系,
 * 用默认值等于让每个用例自己去猜时钟。
 *
 * **`totalUsd` 默认按余额相加**,但可以覆盖 —— 「总额和明细对不上」本身就是要测的一种情形。
 */
export const seedSnapshot = (
  userId: string,
  accountId: string,
  takenAt: number,
  balances: readonly BalanceSpec[],
  totalUsd?: number,
): Promise<string> =>
  db(userId).snapshots.write(accountId, {
    takenAt,
    totalUsd: totalUsd ?? balances.reduce((sum, b) => sum + b.usdValue, 0),
    balances: balances.map((b) => ({
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind ?? "spot",
      tokenId: b.tokenId,
      platform: b.platform,
      selfPrice: b.selfPrice,
      meta: b.meta,
    })),
  });

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
