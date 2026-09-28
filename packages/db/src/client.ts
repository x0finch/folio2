import { Effect } from "effect";
import { type DbEnv, type Drizzle, getDb } from "./connect";

// **D1 这一层的服务面 —— 全包唯一一处 Promise → Effect 的桥。**
//
// #362 第 5 站:参考层的四个 store 出口是 Effect 形状(端口如此),而 drizzle 是 promise 的。
// 桥不能撒在每个方法里(那就是「逐个方法翻译成 Effect」——四个文件几十处 `Effect.promise`,
// 而且想在这一层加一个 span 或一行慢查询日志就得改几十处)。所以它只有一处:这个服务。
// **这笔账已经兑现过一次**:#504 T16 给全部 D1 调用加 span,改的就是下面那两行。
//
// 两个方法就够了,因为 D1 只有两种动作:
//   · `query` —— 跑一个 drizzle 查询构造器(读或单条写)
//   · `batch` —— 一个 D1 batch(它没有交互式事务,batch 就是原子多写那一档)
//
// 文件末尾还有一个 `chunk`。它长得像个通用 util,但它存在的**唯一理由**是 D1 的另一条硬限制
// (每条语句的绑定参数上限),跟上面那条「没有交互式事务」是同一类事实 —— 所以两条限制都住这儿,
// 而不是另起一个叫 `chunk.ts` / `utils.ts` 的文件让人猜它为什么在。
//
// **`env` 不再出现在任何 store 的签名里。** 以前每个工厂第一个参数是 `env`、各自 `getDb(env)`;
// 现在 env 只在装配点被读一次(`provideDbClient(env)`),store 要的是这个服务。
//
// **错误通道是 `never`**:D1 挂了这一层没人救得了它 —— 今天也没有任何调用点 catch 它,行为就是
// 整个请求 500。所以它走 defect(`Effect.promise` 的拒绝),一路冒到 `runPromise`。
// `E` 里只放有人会处理的东西(CODING.md「错误」一节),而这里没有。
type Stmt = Parameters<Drizzle["batch"]>[0][number]; // drizzle BatchItem

// 桥本身:一个 drizzle 句柄 + 两个方法。**纯值**,建它只是 `drizzle(env.DB)` + 两个闭包(见 connect.ts)。
// 收句柄而不是收 env:D1 绑定是一种来源,`./remote.ts` 的 SQL 代理(Node 里的定时任务,FOL-85)是另一种,
// 两者共用这同一段桥 —— span、空 batch 的 no-op、defect 语义都只写一次。
export const connectTo = (db: Drizzle) => {
  return {
    // **span 加在这一处**(#504 T16)。上面那段说的「将来想加 span 只改一处」就是这个。
    // 这一层的名字只有一个(`db.query`),所以它答的是「这一次查询多久」,答不了「哪个 op」。
    // 后者不必给七十个方法各起名字:`database.ts` 的 `bindPerCall` 在聚合出口一并包上
    // (键名 + 方法名 = `accounts.create`),同样是一处、零个方法被改。两处合起来是三层树。
    //
    // **`withSpan` + `captureStackTrace: false`,不用 `Effect.fn`**:后者每**调用**一次就
    // `new Error()` 抓一份调用点,而这里的调用点永远是 store 里那一行 `client.query(…)` 的内部 ——
    // 与 `bindPerCall` 那处同一个理由。一个读快照的请求要发十几条查询,profile 里这一项约 1ms。
    query: <A>(build: (d: Drizzle) => PromiseLike<A>): Effect.Effect<A> =>
      Effect.withSpan(
        Effect.promise(() => build(db)),
        "db.query",
        { captureStackTrace: false },
      ),

    // 一批语句。**同样收一个 builder** —— 语句得拿 `db` 才造得出来,而调用方不该为了造语句先
    // 从服务里把 `db` 掏出来(掏出来它就又能绕过这一层了)。drizzle 的 batch 要求非空
    // `[Stmt, ...Stmt[]]`;空 → no-op。`build(db)` 放在 `suspend` 里:跑的时候才造语句。
    batch: (build: (d: Drizzle) => readonly Stmt[]): Effect.Effect<void> =>
      Effect.withSpan(
        Effect.suspend(() => {
          const [first, ...rest] = build(db);
          return first
            ? Effect.asVoid(Effect.promise(() => db.batch([first, ...rest])))
            : Effect.void;
        }),
        "db.batch",
        { captureStackTrace: false },
      ),
  };
};

const connect = (env: DbEnv) => connectTo(getDb(env));

export class DbClient extends Effect.Service<DbClient>()("db/DbClient", {
  effect: (env: DbEnv) => Effect.sync(() => connect(env)),
}) {}

/**
 * **一次请求一个 `DbClient`(ADR 0045 §3 的红线,原样保留)** —— 装配点给连接的唯一方式。
 *
 * 形状是组合子,不是 layer(ADR 0054):store 不再在建自己那一刻抓住一个句柄,而是每个 op 跑的
 * 那一刻从 context 里取(`database.ts` 的 `bindPerCall`),所以装配点要做的只是「把这一个值放进
 * 这次请求的 context」—— 建一次 layer(memo 表 + scope)是白付的。
 *
 * **句柄在 effect 跑起来那一刻建,不在套上组合子那一刻**(`Effect.sync`):一次 `run*` 建一份,
 * 同一个 effect 跑两次就是两份 —— 与「一次构建一份」的旧口径同一个意思,`one-db-client.test.ts`
 * 数着。模块加载期一次都不碰(Workers 的启动 CPU 限制)。
 *
 * class 本身仍**不出包**(原则 #6):它一出去,包外 `yield* DbClient` 就能拿 `query(build)` 的
 * drizzle 句柄拼任意查询,绕过全部包装层。
 */
export const provideDbClient =
  (env: DbEnv) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, DbClient>> =>
    Effect.provideServiceEffect(
      self,
      DbClient,
      Effect.sync(() => DbClient.make(connect(env))),
    );

// —— D1 的第二条限制:一条语句约 100 个绑定参数 ——
//
// 于是 `WHERE k IN (…)` 这类列表查询不能一把发出去,得切块、一块一条语句。默认 90 是给
// 「几个固定绑定 + 一列 IN」那种形状留的余量;别的形状(比如多行 INSERT,每行占好几个绑定)
// 自己算好传 `size` —— `global-ref-index.ts` 的 `putAll` 就是那样两级分批的。
const IN_CHUNK = 90;

export function chunk<T>(arr: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
