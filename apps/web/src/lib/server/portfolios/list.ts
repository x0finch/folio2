import { Database } from "@folio/db";
import { Effect } from "effect";

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefault 保证至少有默认那行。
//
// **先 list,列表里没有默认那行才 ensureDefault 再 list 一次**(FOL-92)。以前每次都是
// `ensureDefault` → `list` 两条;默认那行一旦建过就永远在列表里,于是首访之后的每一次都只需要
// 一条查询。首访那一次仍然是「先建、后读」的顺序 —— 不能把两句并发(#527 发现 1):list 抢先
// 跑完就读到空表,返回 `{ portfolios: [], defaultId: <一个不在列表里的 id> }` 这种自相矛盾的视图。
export const handleListPortfolios = Effect.fn("listPortfolios")(function* () {
  const store = (yield* Database).portfolios;
  let portfolios = yield* store.list();
  let defaultPf = portfolios.find((p) => p.isDefault);
  if (!defaultPf) {
    defaultPf = yield* store.ensureDefault();
    portfolios = yield* store.list();
  }
  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    defaultId: defaultPf.id,
  };
});
