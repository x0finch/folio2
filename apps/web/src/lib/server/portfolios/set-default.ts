import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export const SetDefaultPortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleSetDefaultPortfolio = Effect.fn("setDefaultPortfolio")(function* (
  data: z.infer<typeof SetDefaultPortfolioInput>,
) {
  yield* (yield* Database).portfolios.setDefault(data.portfolioId);
  // 默认组合一换,两件事同时挪:没有归属行的账户落进哪个视图(`inView` 的兜底),以及
  // 缺省 / 坏 id 解析到哪个组合(`resolveScope`)。**每个组合的数都可能因此变**,所以这里
  // 抬的是用户级那条,不是某一个组合的。
  yield* invalidatePrecomputed();
  return { ok: true as const };
});
