import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import { InvalidInput, NotFound } from "../errors";
import { accounts, accountTags, portfolioAccounts, portfolios, user } from "../schema";
import type { Portfolio } from "../schema/types";
import { assertAccountOwned, assertPortfolioOwned } from "./ownership";

// Portfolio —— 命名账户集(ADR 0033)。每个账户恰属一个,新用户首次落地建默认那个。
//
// **服务的方法签名里没有 userId**(ADR 0037):它由 `PortfolioStore.Default(userId)` 在装配那一刻
// 吃掉,拿错用户在编译期就发生不了。方法名也不再带领域前缀(`createPortfolio` → `create`)——
// 服务本身就是领域,名字里再带一遍是平铺函数时代的遗留。

// 默认 Portfolio 名:`<用户名>'s`,用户名为空兜底 `My Portfolio`。
// **必须与迁移 0003 的 seed SQL 保持一致**(那里对存量用户 seed 同名规则)。
const PORTFOLIO_NAME_SUFFIX = "'s";
const PORTFOLIO_FALLBACK_NAME = "My Portfolio";
function defaultPortfolioName(userName: string | null | undefined): string {
  const n = (userName ?? "").trim();
  return n ? `${n}${PORTFOLIO_NAME_SUFFIX}` : PORTFOLIO_FALLBACK_NAME;
}

// 每用户内名字是否已被占(忽略大小写;可排除自身供改名用)。唯一索引
// `portfolios_user_name_uidx` 才是并发下真正兜底那道;这一步只是先挡住、好给出一句人话
// (与 tags 里的 `tagNameTaken` 同形 —— 同一道题不该有两种手感)。
async function nameTaken(
  db: Drizzle,
  userId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      and(
        eq(portfolios.userId, userId),
        // 与索引 `portfolios_user_name_uidx` 的表达式逐字一致 —— 两边不一样的话,这一步放过去
        // 的名字会在插入时撞索引,而那一撞是 defect(用户拿到一坨 Cause)。
        sql`lower(trim(${portfolios.name})) = lower(trim(${name}))`,
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

const NAME_TAKEN = (name: string) =>
  new InvalidInput({ what: "portfolio", why: `name already used: ${name}` });

// 默认那个的名字**只能让它成**:它不是用户当场输入的,没有「换一个」这一步可走。
// 若 `<用户名>'s` 已被一个命名 Portfolio 占了(需要「没有默认」+「刚好同名」两件事同时成立,
// 罕见但不是不可能),补 ` (2)`、` (3)` 直到空闲 —— 否则插入会撞索引,而那一撞会 die 在
// 「第一次打开应用」这条路上。
const DEFAULT_NAME_TRIES = 20;
const freeDefaultName = (client: DbClient, userId: string, base: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    for (let n = 1; n <= DEFAULT_NAME_TRIES; n++) {
      const candidate = n === 1 ? base : `${base} (${n})`;
      if (!(yield* client.query((db) => nameTaken(db, userId, candidate)))) return candidate;
    }
    // 二十个都占着 → 不是数据形状问题,是有人在刷。带上 id 让它可查,别静默换一个随机名。
    return `${base} (${crypto.randomUUID().slice(0, 8)})`;
  });

export interface PortfolioMembership {
  accountId: string;
  portfolioId: string;
}

const selectDefault = (client: DbClient, userId: string): Effect.Effect<Portfolio | undefined> =>
  client.query((db) =>
    db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true)))
      .limit(1)
      .then((rows) => rows[0]),
  );

// **包内函数,不是只有服务方法。** 建账户那一步也要它(accounts.ts),而让 `AccountStore` 的 layer
// 依赖 `PortfolioStore` 只是为了调一个函数 —— 那会把两个 store 的装配顺序绑死,换不来任何东西。
// 服务方法 `ensureDefault` 就是它绑上 userId 之后的样子。
// onConflictDoNothing + 事后重查:并发下两个实例都「查不到→插」时,唯一索引让其一失败、两者都拿回同一行。
export const ensureDefault = (client: DbClient, userId: string): Effect.Effect<Portfolio> =>
  Effect.gen(function* () {
    const found = yield* selectDefault(client, userId);
    if (found) return found;
    const named = yield* client.query((db) =>
      db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1),
    );
    const name = yield* freeDefaultName(client, userId, defaultPortfolioName(named[0]?.name));
    yield* client.query((db) =>
      db
        .insert(portfolios)
        .values({
          id: crypto.randomUUID(),
          userId,
          name,
          isDefault: true,
          sortOrder: 0,
          createdAt: Date.now(),
        })
        .onConflictDoNothing(),
    );
    const after = yield* selectDefault(client, userId);
    if (!after) {
      return yield* Effect.die(new Error(`failed to ensure default portfolio for user ${userId}`));
    }
    return after;
  });

export const makePortfolioStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 拿默认 Portfolio,没有就建一个(find-or-create,幂等)。 */
    ensureDefault: (): Effect.Effect<Portfolio> => ensureDefault(client, userId),

    // 该用户的全部 Portfolio,按**创建时间**稳定排序(不把默认置顶 —— 切换默认时列表不重排;ADR 0033)。
    // id 作最终 tiebreaker,避免同毫秒 createdAt 的顺序不确定。
    list: (): Effect.Effect<Portfolio[]> =>
      client.query((db) =>
        db
          .select()
          .from(portfolios)
          .where(eq(portfolios.userId, userId))
          .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt), asc(portfolios.id)),
      ),

    // 该用户全部 账户→Portfolio 归属(accountsInView 的过滤原料)。一次查询(portfolio_accounts ⨝ accounts 限 user)。
    listMemberships: (): Effect.Effect<PortfolioMembership[]> =>
      client.query((db) =>
        db
          .select({
            accountId: portfolioAccounts.accountId,
            portfolioId: portfolioAccounts.portfolioId,
          })
          .from(portfolioAccounts)
          .innerJoin(accounts, eq(accounts.id, portfolioAccounts.accountId))
          .where(eq(accounts.userId, userId)),
      ),

    // 建一个**命名(非默认)** Portfolio(选择器「新建…」/「移到→新建」用)。默认 Portfolio 只由
    // ensureDefault 造,这里永不建默认(is_default=false),故不碰部分唯一索引。
    create: (input: { name: string; sortOrder?: number }): Effect.Effect<Portfolio, InvalidInput> =>
      Effect.gen(function* () {
        // 撞名 → 类型化拒绝(#527 裁定 5)。**双击提交也走这条**:第二下和第一下同名,
        // 于是被同一句话挡住 —— 不必再为它单独铺一套幂等键。
        const name = input.name.trim();
        if (yield* client.query((db) => nameTaken(db, userId, name))) {
          return yield* Effect.fail(NAME_TAKEN(name));
        }
        const row = {
          id: crypto.randomUUID(),
          userId,
          name,
          isDefault: false,
          sortOrder: input.sortOrder ?? 0,
          createdAt: Date.now(),
        };
        yield* client.query((db) => db.insert(portfolios).values(row));
        return row;
      }),

    // 把账户归属到某 Portfolio(一对一:先删该账户现有归属行,再插新的,一个 batch 原子换)。
    // 两个资源都做 owner 断言,杜绝越权。
    // **同 batch 清空该账户的全部 Tag**(ADR 0034):Tag 属于原 Portfolio,搬家后对新家是外来的,
    // 带过去会破坏「账户只有其所在 Portfolio 的 Tag」这条不变量 —— 故随归属变更一并清掉,新家里重新打。
    assignAccount: (accountId: string, portfolioId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        // `ownership.ts` 仍是 Promise 形状(它被五个领域共用,三个还没迁)。**不为此新增桥** ——
        // `client.query` 收的就是「拿 drizzle 句柄做点事」的回调,把它套进去即可,
        // 全包仍只有 `DbClient` 那一处 `Effect.promise`(CODING.md「桥只留一处」)。
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertPortfolioOwned(client, userId, portfolioId);
        // 已在目标 Portfolio → 真 no-op。否则下面的「清空该账户 Tag」会在没真搬家时也误删标签
        // (重新指到当前 Portfolio 本应无副作用)。
        const current = yield* client.query((db) =>
          db
            .select({ portfolioId: portfolioAccounts.portfolioId })
            .from(portfolioAccounts)
            .where(eq(portfolioAccounts.accountId, accountId)),
        );
        if (current[0]?.portfolioId === portfolioId) return;
        yield* client.batch((db) => [
          db.delete(portfolioAccounts).where(eq(portfolioAccounts.accountId, accountId)),
          db.insert(portfolioAccounts).values({ portfolioId, accountId }),
          db.delete(accountTags).where(eq(accountTags.accountId, accountId)),
        ]);
      }),

    // 改 Portfolio 名(含默认,因它是真行)。userId 作用域,越权即影响 0 行。
    // 撞名同 create 一样类型化拒(#527 裁定 5);改成自己现在的名字(只动大小写/空格)不算撞。
    rename: (portfolioId: string, name: string): Effect.Effect<void, InvalidInput> =>
      Effect.gen(function* () {
        const next = name.trim();
        if (yield* client.query((db) => nameTaken(db, userId, next, portfolioId))) {
          return yield* Effect.fail(NAME_TAKEN(next));
        }
        yield* client.query((db) =>
          db
            .update(portfolios)
            .set({ name: next })
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        );
      }),

    // 设为默认:先清掉该用户当前默认(→ 无默认),再把目标置默认(→ 恰一个)。两步一个 batch 原子换,
    // 中途不出现「两个默认」违反部分唯一索引。
    setDefault: (portfolioId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertPortfolioOwned(client, userId, portfolioId);
        yield* client.batch((db) => [
          db
            .update(portfolios)
            .set({ isDefault: false })
            .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true))),
          db
            .update(portfolios)
            .set({ isDefault: true })
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        ]);
      }),

    // 删 Portfolio:默认不可删。否则先把成员退回默认 Portfolio,再删该行(成员账户不动、不孤儿)。
    //
    // **两种拒绝都是类型化失败**(#527 裁定 4):以前都是 `die` —— 而这两个请求一个陈旧页面就发得出
    // (另一个标签页刚把它删了 / 刚把它设成默认),用户于是收到一坨 Cause,而不是「默认的那个不能删」。
    remove: (portfolioId: string): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        const rows = yield* client.query((db) =>
          db
            .select({ isDefault: portfolios.isDefault })
            .from(portfolios)
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        );
        const target = rows[0];
        // 「不存在」与「不是你的」共用 NotFound,与全库同一条规矩(见 errors.ts 那段注释:
        // 分开报等于给出一个探测别人 id 的接口)。
        if (!target) {
          return yield* Effect.fail(new NotFound({ entity: "portfolio", id: portfolioId }));
        }
        if (target.isDefault) {
          return yield* Effect.fail(
            new InvalidInput({ what: "portfolio", why: "the default portfolio cannot be deleted" }),
          );
        }
        const def = yield* ensureDefault(client, userId);
        yield* client.batch((db) => [
          // 成员退回默认(1:1 不冲突:成员在 target,不在 default → 改指 default 无碰撞)。
          db
            .update(portfolioAccounts)
            .set({ portfolioId: def.id })
            .where(eq(portfolioAccounts.portfolioId, portfolioId)),
          db
            .delete(portfolios)
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        ]);
      }),
  };
});
