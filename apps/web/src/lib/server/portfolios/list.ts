import { Database } from "@folio/db";
import { Effect } from "effect";

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefault 保证至少有默认那行。
export const handleListPortfolios = Effect.fn("listPortfolios")(function* () {
  const store = (yield* Database).portfolios;
  const [portfolios, defaultPf] = yield* Effect.all([store.list(), store.ensureDefault()], {
    concurrency: 2,
  });
  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    defaultId: defaultPf.id,
  };
});
