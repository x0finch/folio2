import { Database } from "@folio/db";
import { Effect } from "effect";

// 这个用户的数据版本号(FOL-94):浏览器缓存了查询结果(IndexedDB),回到页面 / 定时只问这一个数,
// 变了才重拉那批数据查询(`lib/queries/data-version.ts`)。一次主键点查,不碰参考层、不出网。
//
// 号是库里的触发器抬的(`@folio/db` 迁移 0010),所以任何一处写 —— 同步、手记、导入、改设置 ——
// 都不必记得这里。
export const handleGetDataVersion = Effect.fn("getDataVersion")(function* () {
  const version = yield* (yield* Database).dataVersion.get();
  return { version };
});
