import { env } from "cloudflare:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { DbClient, provideDbClient } from "../src/client";
import type { DbEnv } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database, DatabaseForOracle, GlobalDatabase } from "../src/database";

// **一次请求只有一个 drizzle 句柄。** 这条是红线(ADR 0044/0045,#504 T13),ADR 0054 之后
// **一个字没动** —— 变的是给法:门票(`Database` 等)每个 isolate 建一次,不再握着连接;连接由
// 装配点每请求 `provideDbClient(env)` 一次,每个 op 跑的那一刻从 context 里取。
//
// 于是「一次请求一个」的机制从「layer memoisation 的作用域是一次构建」换成了更直白的一条:
// **context 里只有一个值,谁读都是它**。下面钉的是这条,外加它的负对照。
//
// **怎么数**:`drizzle(env.DB)` 读一次 `env.DB` —— 给一个 `DB` 是 getter 的 env,读几次就是
// 建了几个句柄。数的是真构造,不是引用比对(门票不再握着句柄,比对也无从比起)。
const counting = (): { env: DbEnv; built: () => number } => {
  let n = 0;
  return {
    env: {
      get DB() {
        n += 1;
        return env.DB;
      },
    },
    built: () => n,
  };
};

// 与生产同形:三张门票一次建好(生产里是 isolate 级的 `ManagedRuntime`),之后每个请求只给两样值。
const tickets = Layer.mergeAll(
  Database.Default,
  DatabaseForOracle.Default("coingecko"),
  GlobalDatabase.Default,
);

// 一次「请求」:跨三张门票、四个领域各跑一个 op。
const oneRequest = Effect.gen(function* () {
  const db = yield* Database;
  const forOracle = yield* DatabaseForOracle;
  const global = yield* GlobalDatabase;
  yield* db.accounts.list();
  yield* db.settings.get();
  yield* forOracle.cache.get("probe");
  yield* global.accounts.listUserIds();
});

describe("一次请求一个 DbClient", () => {
  it("一次请求里跨门票、跨领域的全部 op → 只建一个句柄", async () => {
    const c = counting();
    const runtime = ManagedRuntime.make(tickets);
    await runtime.runPromise(
      oneRequest.pipe(provideCurrentUser("user-probe"), provideDbClient(c.env)),
    );
    expect(c.built()).toBe(1);
    await runtime.dispose();
  });

  it("同一次请求里两处去读,拿到的是同一个句柄", async () => {
    const [a, b] = await Effect.runPromise(
      Effect.all([DbClient, DbClient]).pipe(provideDbClient(env)),
    );
    expect(a).toBe(b);
  });

  // **负对照。** 证明计数器数的真是构造(第一条的 1 不是「计数器没在数」的假象),而且句柄是
  // **跑一次建一次**(`Effect.sync`,不是套上组合子那一刻)。门票则跨请求是同一份 —— 这正是
  // ADR 0054 要的形状。另起一条根 fiber 也就是另一次「跑」:`/api/sync` 的后台任务(#504 T12)。
  it("同一个组合子跑两次 → 两个句柄;门票仍是同一份", async () => {
    const c = counting();
    const runtime = ManagedRuntime.make(tickets);
    const request = oneRequest.pipe(
      Effect.zipRight(Database),
      provideCurrentUser("user-probe"),
      provideDbClient(c.env),
    );
    const first = await runtime.runPromise(request);
    const second = await runtime.runPromise(request);
    expect(c.built()).toBe(2);
    expect(first).toBe(second);
    await runtime.dispose();
  });
});
