import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as db from "@folio/db";
import { Database, DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserServices } from "@/lib/server/runtime";

// **handler 能看见什么** —— 这条钉的是可见面本身,不是某个 handler(#504 T17)。
//
// 参考层的代币行与价格行曾经整组露在 `UserServices` 里,于是任何 handler 都能直接改代币行、
// 绕过 mint 与 SWR 编排。现在它们只在 `DatabaseForOracle` 上,而那张票只喂给 `@folio/oracle`。
//
// 断言写成**类型层**的:`R` 落在 `UserServices` 里的 effect 编译得过,落在外面的编译不过。
describe("UserServices 的面", () => {
  it("三张门票在里面", () => {
    const inSurface: Effect.Effect<unknown, never, UserServices>[] = [
      Effect.flatMap(Database, (db) => db.accounts.list()),
      Effect.flatMap(Oracle, (o) => o.fx.warm([])),
      // app 直接用的那片 KV 缓存(DeFi 协议图)。它是 `Database` 的一个字段 ——
      // 不再是从参考层的装配里漏出来的一个端口。
      Effect.flatMap(Database, (db) => db.cache.get("defi-logo:aave")),
    ];
    expect(inSurface).toHaveLength(3);
  });

  it("参考层那张票不在 —— 取它的 effect 不是 UserServices 的 effect", () => {
    // @ts-expect-error DatabaseForOracle 不在 handler 的可见面里(#504 T17)
    const tokens: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokens.getByIds([]),
    );
    // @ts-expect-error 同上:价格行也只有参考层碰得到
    const prices: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokenPrices.getByIds([]),
    );
    expect([tokens, prices]).toHaveLength(2);
  });

  it("不带 userId 的那张票也不在 —— 它是 cron 的,不是 handler 的", () => {
    // @ts-expect-error GlobalDatabase 由 cron 侧自己装配(server.ts / withGlobalDb)
    const ids: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(GlobalDatabase, (db) =>
      db.accounts.listUserIds(),
    );
    expect(ids).toBeDefined();
  });
});

// **「这是谁的请求」只有装配点能说**(ADR 0054)。
//
// 服务图每个 isolate 建一次之后,用户不再是「建服务那一刻」绑死的,而是每个 op 跑的那一刻从
// context 里读 —— 于是「同一个实例对不同用户各跑一遍」成了日常(两个请求并发就是)。那不危险,
// 危险的是**有人能随手给一段 effect 换一个用户**。所以材料本身被收走:`CurrentUser` 的 Tag 不出
// `@folio/db`(只出类型),包外唯一的给法是 `provideCurrentUser`,而 app 的源码里只许
// `lib/server/runtime.ts` 写它。下面两条一条钉类型、一条钉源码。
describe("给 user 的材料只在装配点", () => {
  it("`CurrentUser` 出包只是类型 —— 包外拿不到能 `Layer.succeed` 的那个值", () => {
    // @ts-expect-error `CurrentUser` 是 `export type`:当值用编译不过(运行时也确实不在)
    const tag = db.CurrentUser;
    expect(tag).toBeUndefined();
    expect(typeof db.provideCurrentUser).toBe("function");
  });

  // 投队列消息要带 userId(#571 review):handler 经 `enqueueForUser` 投,userId 由装配点填。
  // 给这个服务的材料同样收在 runtime.ts —— Tag 当值拿不到,就没法替别人投一条消息。
  // (这个文件跑在 node 池里,import 不了 runtime.ts 的值,所以查的是模块的**类型**与源码。)
  it("`UserJobs` 出 runtime.ts 只是类型 —— 包外只有 `enqueueForUser`,没有能 provide 的 Tag", () => {
    type Runtime = typeof import("@/lib/server/runtime");
    // @ts-expect-error `UserJobs` 是 `export type`:模块上没有这个值
    type Tag = Runtime["UserJobs"];
    const enqueueForUser: keyof Runtime = "enqueueForUser";
    expect(enqueueForUser).toBe("enqueueForUser");
    expect<Tag | undefined>(undefined).toBeUndefined();
    const src = readFileSync(join(__dirname, "../src/lib/server/runtime.ts"), "utf8");
    expect(src).toMatch(/^class UserJobs extends Context\.Tag\("web\/UserJobs"\)/m);
    expect(src).toMatch(/^export type \{ UserJobs \};$/m);
  });

  it("app 源码里提到 `CurrentUser`(含 `provideCurrentUser`、Tag 的键)、`provideDbClient` 或 `UserJobs` 的 Tag 键的只有 runtime.ts", () => {
    const src = join(__dirname, "../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : /\.tsx?$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    const offenders = walk(src)
      .filter((f) => /CurrentUser|provideDbClient|web\/UserJobs/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    // 查的是子串,所以 `provideCurrentUser`、`"db/CurrentUser"`(自造一个同键的 Tag 顶上去)
    // 都算在内;`provideDbClient` 同理 —— 两个 provide 都只许出现在发动点。**名单只许短不许长**:要给 user 的新地方,该去 runtime.ts 里拿现成的发动点。
    expect(offenders).toEqual(["lib/server/runtime.ts"]);
  });
});
