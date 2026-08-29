import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidateGain24h } from "@/lib/server/portfolio/gain";

// 把账户移到某 Portfolio:传 portfolioId 移到既有,或传 newName 一步「新建命名 Portfolio + 归属」
// (抽屉「移到 → 新建…」)。至少给其一(refine 把关)。返回归属到的 portfolioId(客户端据此可切换选中)。
export const MoveAccountInput = z
  .object({
    accountId: z.string().min(1),
    portfolioId: z.string().min(1).optional(),
    newName: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.portfolioId != null || v.newName != null, {
    message: "portfolioId or newName required",
  });

export const handleMoveAccountToPortfolio = Effect.fn("moveAccountToPortfolio")(function* (
  data: z.infer<typeof MoveAccountInput>,
) {
  const store = (yield* Database).portfolios;
  const targetId = data.newName
    ? (yield* store.create({ name: data.newName })).id
    : // biome-ignore lint/style/noNonNullAssertion: 上面的 refine 保证 portfolioId 或 newName 至少其一
      data.portfolioId!;
  yield* store.assignAccount(data.accountId, targetId);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidateGain24h();
  return { portfolioId: targetId };
});
