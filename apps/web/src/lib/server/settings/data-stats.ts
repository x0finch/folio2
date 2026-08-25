import { Database } from "@folio/db";
import { Effect } from "effect";

// 库里是否已有账户数据(设置页导入前的提醒用):非空则合并式导入前弹一道确认。只回布尔。
//
// **这个布尔只答一个问题:「合并式导入会不会撞上已有数据」**(#527 裁定 7)。所以它**含归档账户**
// —— 归档只是退场,数据还在,导入照样会与它合并。
//
// **别拿它判「是不是新用户」。** 一个把全部账户归档了的老用户在这里是 `true`,而按「新用户」问
// 的话答案该是 `false`;那时要的是另一个口径(未归档账户数),得另开一个 op,不是改这一个 ——
// 改了这边,导入提醒就会在「库里明明有归档数据」时说无数据。tests/server/settings 那条用例的
// 名字把这件事钉住了。
export const handleGetDataStats = Effect.fn("getDataStats")(function* () {
  const accounts = yield* (yield* Database).accounts.list();
  return { hasData: accounts.length > 0 };
});
