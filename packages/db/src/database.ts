import { Context, Effect, Layer } from "effect";
import { makeTabPinStore, type TabPinOps } from "./queries/tab-pins";
import type { DbClient } from "./stores/service";

// **`@folio/db` 对外的那一张门票。** app 侧一次 `yield* Database` 拿到全部领域操作,
// 按领域取用:`db.tabPins.list()`。以前是每个领域一个 Tag + 一个 layer 散装导出(九对),
// 装配点为此 import 二十几行,handler 各自记住自己要哪几个 Tag。
//
// **它和 `stores/service.ts` 的 `DbClient` 是两件事,别混**:
//   · `DbClient` —— D1 这一层的桥(`query` / `batch`),回调参数就是 drizzle 句柄。
//     **只在包内流通**(原则 #6):出包了包外就能拼任意查询,绕过全部包装。
//   · `Database` —— 本文件,包装好的领域 op 的聚合。**出包正是它的用途。**
//
// **不自己开连接。** `layer(userId)` 的 `R` 通道声明 `DbClient`,谁装配谁给。这是硬性红线:
// 一次请求只能有一个 drizzle 句柄。如果这里自己 `dbClientLayer(env)`,那参考层那四个端口
// (它们也要 `DbClient`)就只能各自再开一条 —— 一次请求握着两三个句柄,今天只是浪费,
// 等这一层长出状态(span、慢查询计数)就是悄悄劈成几半的状态。
// 装配点(app 的 `lib/server/oracle.ts`)建一次 `dbClientLayer(env)`,一个 `Layer.provide`
// 分给所有人,Effect 的 layer memoisation 保证只建一次。
//
// **userId 在装配那一刻被吃掉**(ADR 0037):下面每个字段的方法签名里一个 user 参数都没有,
// 拿错用户在编译期就发生不了。
//
// 现在只有 `tabPins` 一个字段 —— P0 打样只搬了这一个领域。其余八个领域仍走各自的 Tag,
// 按域一片一片挂进来(见 #504 的 T7–T12),挂完那些 Tag 就没有消费者了,随之删除。
export class Database extends Context.Tag("db/Database")<
  Database,
  {
    readonly tabPins: TabPinOps;
  }
>() {
  static layer = (userId: string): Layer.Layer<Database, never, DbClient> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        return {
          tabPins: yield* makeTabPinStore(userId),
        };
      }),
    );
}
