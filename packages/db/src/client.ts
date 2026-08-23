import { Effect } from "effect";
import { type DbEnv, type Drizzle, getDb } from "./connect";

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
// 文件末尾还有一个 `chunk`。它长得像个通用 util,但它存在的**唯一理由**是 D1 的另一条硬限制
// (每条语句的绑定参数上限),跟上面那条「没有交互式事务」是同一类事实 —— 所以两条限制都住这儿,
// 而不是另起一个叫 `chunk.ts` / `utils.ts` 的文件让人猜它为什么在。
//
// **`env` 不再出现在任何 store 的签名里。** 以前每个工厂第一个参数是 `env`、各自 `getDb(env)`;
// 现在 env 只在装配点被读一次(`dbClientLayer(env)`),store 要的是这个服务。
// 「Bind ambient env once, at a single call site」那条(CODING.md)在 Effect 里的形状就是 Layer。
//
// **错误通道是 `never`**:D1 挂了这一层没人救得了它 —— 今天也没有任何调用点 catch 它,行为就是
// 整个请求 500。所以它走 defect(`Effect.promise` 的拒绝),一路冒到 `runPromise`。
// `E` 里只放有人会处理的东西(CODING.md「错误」一节),而这里没有。
type Stmt = Parameters<Drizzle["batch"]>[0][number]; // drizzle BatchItem

// **`Effect.sync` 而不是 `Effect.succeed`**:`drizzle(env.DB)` 要到 layer 真被建的那一刻才发生
// (模块加载期一次都不碰 —— Workers 的启动 CPU 限制)。它本身很轻(见 connect.ts),
// 所以一次请求建一份没有代价。
export class DbClient extends Effect.Service<DbClient>()("db/DbClient", {
  effect: (env: DbEnv) =>
    Effect.sync(() => {
      const db = getDb(env);
      return {
        query: <A>(build: (d: Drizzle) => PromiseLike<A>): Effect.Effect<A> =>
          Effect.promise(() => build(db)),

        // 一批语句。**同样收一个 builder** —— 语句得拿 `db` 才造得出来,而调用方不该为了造语句先
        // 从服务里把 `db` 掏出来(掏出来它就又能绕过这一层了)。drizzle 的 batch 要求非空
        // `[Stmt, ...Stmt[]]`;空 → no-op。
        batch: (build: (d: Drizzle) => readonly Stmt[]): Effect.Effect<void> =>
          Effect.suspend(() => {
            const [first, ...rest] = build(db);
            return first
              ? Effect.asVoid(Effect.promise(() => db.batch([first, ...rest])))
              : Effect.void;
          }),
      };
    }),
}) {}

// 包出口只转这个别名 + `type DbClient`,**class 本身不出包**(原则 #6):它一出去,包外
// `yield* DbClient` 就能拿 `query(build)` 的 drizzle 句柄拼任意查询,绕过全部包装层。
export const dbClientLayer = DbClient.Default;

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
