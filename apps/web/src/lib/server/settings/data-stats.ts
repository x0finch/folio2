import { Database } from "@folio/db";
import { Effect } from "effect";

// 库里是否已有账户数据(设置页导入前的提醒用):非空则合并式导入前弹一道确认。只回布尔。
export const handleGetDataStats = Effect.fn("getDataStats")(function* () {
  const accounts = yield* (yield* Database).accounts.list();
  return { hasData: accounts.length > 0 };
});
