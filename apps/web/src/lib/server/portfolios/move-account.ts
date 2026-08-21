import { PortfolioStore } from "@folio/db";
import { Effect } from "effect";
import { runStore } from "../oracle";

// 把账户移到某 Portfolio:传 portfolioId 移到既有,或传 newName 一步「新建命名 Portfolio + 归属」
// (抽屉「移到 → 新建…」)。至少给其一(index 的 refine 把关)。返回归属到的 portfolioId(客户端据此可切换选中)。
export async function handleMoveAccountToPortfolio({
  data,
  context,
}: {
  data: { accountId: string; portfolioId?: string; newName?: string };
  context: { userId: string };
}) {
  // 建 Portfolio + 归属**一次装配**:它们本来就是一步操作的两半。
  const targetId = await runStore(context.userId, PortfolioStore, (s) =>
    Effect.gen(function* () {
      const id = data.newName
        ? (yield* s.create({ name: data.newName })).id
        : // biome-ignore lint/style/noNonNullAssertion: index 的 refine 保证 portfolioId 或 newName 至少其一
          data.portfolioId!;
      yield* s.assignAccount(data.accountId, id);
      return id;
    }),
  );
  return { portfolioId: targetId };
}
