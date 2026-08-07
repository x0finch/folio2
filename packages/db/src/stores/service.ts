import { Context, Effect, Layer } from "effect";
import { type DbEnv, type Drizzle, getDb } from "../connect";

// **D1 这一层的服务面 —— 全包唯一一处 Promise → Effect 的桥。**
//
// #362 第 5 站:参考层的四个 store 出口是 Effect 形状(端口如此),而 drizzle 是 promise 的。
// 桥不能撒在每个方法里(那就是「逐个方法翻译成 Effect」——四个文件几十处 `Effect.promise`,
// 而且将来想在这一层加一个 span 或一行慢查询日志就得改几十处)。所以它只有一处:这个服务。
//
// 两个方法就够了,因为 D1 只有两种动作:
//   · `query` —— 跑一个 drizzle 查询构造器(读或单条写)
//   · `batch` —— 一个 D1 batch(它没有交互式事务,batch 就是原子多写那一档)
//
// **`env` 不再出现在任何 store 的签名里。** 以前每个工厂第一个参数是 `env`、各自 `getDb(env)`;
// 现在 env 只在装配点被读一次(`databaseLayer(env)`),store 要的是这个服务。
// 「Bind ambient env once, at a single call site」那条(CODING.md)在 Effect 里的形状就是 Layer。
//
// **错误通道是 `never`**:D1 挂了这一层没人救得了它 —— 今天也没有任何调用点 catch 它,行为就是
// 整个请求 500。所以它走 defect(`Effect.promise` 的拒绝),一路冒到 `runPromise`。
// `E` 里只放有人会处理的东西(CODING.md「错误」一节),而这里没有。
export interface Database {
  readonly query: <A>(build: (db: Drizzle) => PromiseLike<A>) => Effect.Effect<A>;
  // 一批语句。**同样收一个 builder** —— 语句得拿 `db` 才造得出来,而调用方不该为了造语句先
  // 从服务里把 `db` 掏出来(掏出来它就又能绕过这一层了)。drizzle 的 batch 要求非空
  // `[Stmt, ...Stmt[]]`;空 → no-op。
  readonly batch: (build: (db: Drizzle) => readonly Stmt[]) => Effect.Effect<void>;
}

type Stmt = Parameters<Drizzle["batch"]>[0][number]; // drizzle BatchItem

export const Database = Context.GenericTag<Database>("db/Database");

const make = (db: Drizzle): Database => ({
  query: (build) => Effect.promise(() => build(db)),
  batch: (build) =>
    Effect.suspend(() => {
      const [first, ...rest] = build(db);
      return first ? Effect.asVoid(Effect.promise(() => db.batch([first, ...rest]))) : Effect.void;
    }),
});

// **`Layer.sync` 而不是 `Layer.succeed`**:`drizzle(env.DB)` 要到 layer 真被建的那一刻才发生
// (模块加载期一次都不碰 —— Workers 的启动 CPU 限制)。它本身很轻(见 client.ts),
// 所以一次请求建一份没有代价。
export const databaseLayer = (env: DbEnv): Layer.Layer<Database> =>
  Layer.sync(Database, () => make(getDb(env)));
