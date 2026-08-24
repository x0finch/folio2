import type { ConnectorId } from "@folio/connectors";
import type { AccountSafe } from "@folio/db";
import { createManualAccount } from "@/lib/server/manual/store";
import { db } from "./db";
import { call } from "./run";

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

/**
 * 手记账户:建账户 + 首个 token 声明 + 开仓那一笔。
 *
 * 走的是生产那条路(`createManualAccount`),所以它顺带覆盖了「建手记账户」本身 ——
 * 夹具与被测行为在这里是同一件事,而这正是手记那一片的性质:账本就是事实。
 */
export const seedManualAccount = (
  userId: string,
  label: string,
  token: { symbol: string; unitPrice: number; amount: number },
): Promise<AccountSafe> =>
  call(
    userId,
    createManualAccount(
      label,
      JSON.stringify([{ symbol: token.symbol, unitPrice: token.unitPrice, amount: token.amount }]),
    ),
  );
