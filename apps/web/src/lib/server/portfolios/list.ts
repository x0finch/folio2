import { Database } from "@folio/db";
import { Effect } from "effect";

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefault 保证至少有默认那行。
//
// **必须先 ensureDefault 再 list,不能并发**(#527 发现 1):默认那行正是 ensureDefault 在
// 首访那一次写进去的 —— 两句并发时 list 抢先跑完就读到空表,首访返回
// `{ portfolios: [], defaultId: <一个不在列表里的 id> }` 这种自相矛盾的视图。第二次起就正常,
// 所以它藏了很久。省下的那点并行不值当:首访之后 ensureDefault 只是一次 SELECT。
export const handleListPortfolios = Effect.fn("listPortfolios")(function* () {
  const store = (yield* Database).portfolios;
  const defaultPf = yield* store.ensureDefault();
  const portfolios = yield* store.list();
  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    defaultId: defaultPf.id,
  };
});
