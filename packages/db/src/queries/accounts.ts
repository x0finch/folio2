import type { ConnectorId } from "@folio/connectors";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { accounts, portfolioAccounts } from "../schema";
import type { AccountSafe } from "../schema/types";
import { DbClient } from "../stores/service";
import { ensureDefault } from "./portfolios";

// 账户:建 / 列 / 改名 / 归档 / 删,外加 creds 的原样存取(db 不解释 creds 的内容)。
//
// **服务的方法签名里没有 userId**(ADR 0037):它由 `AccountStore.Default(userId)` 在装配那一刻吃掉。
// 方法名也不再带领域前缀(`createAccount` → `create`)—— 服务本身就是领域。

// 安全列:不含 creds(内含 secret 密文),常规查询一律走这组列。
const accountSafeColumns = {
  id: accounts.id,
  userId: accounts.userId,
  connectorId: accounts.connectorId,
  platform: accounts.platform,
  label: accounts.label,
  createdAt: accounts.createdAt,
  archivedAt: accounts.archivedAt,
};

export interface CreateAccountInput {
  connectorId: ConnectorId;
  platform?: string;
  label: string;
  creds: string | null; // 凭据 map 的 JSON(db 不解释);缺凭据态由 isComplete(inputs, creds) 在内存判定
}

// 批量取该用户全部账户的原始 creds(server 端富化 listMyAccounts 用:算 needsCredentials + safeView)。
// 返回含 secret 密文,只在服务端用、投影后才出网。
export interface AccountRawCreds {
  id: string;
  creds: string | null;
}

// ⚠️ 系统级查询 —— 原则 #6(全部按 userId 作用域)的【唯一、受控例外】,仅供定时同步调度器(P6.3)
// 跨用户枚举。不接受/不返回任何用户数据,只回有账户的去重 userId 列表供逐个 syncUser。
// 不要在请求处理(server fn)里调用它。
//
// **不做成服务**(ADR 0037):它没有 userId,塞不进 per-user 的 layer;而单独给它造一个 Tag 也不对 ——
// Tag 的意义是「可以被换掉」,这一条只有一个实现、从不被顶替(#392 把 `RefIndexWarmer` 去 Tag 化
// 同理)。所以它就是一个裸 Effect,依赖留在 `R` 上,由调用方 provide `dbClientLayer`。
export const listUserIdsWithAccounts: Effect.Effect<string[], never, DbClient> = Effect.gen(
  function* () {
    const database = yield* DbClient;
    const rows = yield* database.query((db) =>
      db.selectDistinct({ userId: accounts.userId }).from(accounts),
    );
    return rows.map((r) => r.userId);
  },
);

const make = (userId: string) =>
  Effect.gen(function* () {
    const database = yield* DbClient;

    return {
      // 不变量(ADR 0033):每个账户恰一行归属。新账户落进用户的默认 Portfolio —— 建账户与建归属
      // 一个 batch 原子写,杜绝「有账户没归属」的空窗(否则该账户会从 accountsInView 里消失)。
      create: (input: CreateAccountInput): Effect.Effect<AccountSafe> =>
        Effect.gen(function* () {
          const pf = yield* ensureDefault(database, userId);
          const id = crypto.randomUUID();
          const createdAt = Date.now();
          const platform = input.platform ?? null;
          yield* database.batch((db) => [
            db.insert(accounts).values({
              id,
              userId,
              connectorId: input.connectorId,
              platform,
              label: input.label,
              creds: input.creds,
              createdAt,
            }),
            db.insert(portfolioAccounts).values({ portfolioId: pf.id, accountId: id }),
          ]);
          return {
            id,
            userId,
            connectorId: input.connectorId,
            platform,
            label: input.label,
            createdAt,
            archivedAt: null,
          };
        }),

      list: (): Effect.Effect<AccountSafe[]> =>
        database.query((db) =>
          db.select(accountSafeColumns).from(accounts).where(eq(accounts.userId, userId)),
        ),

      getById: (id: string): Effect.Effect<AccountSafe | null> =>
        Effect.map(
          database.query((db) =>
            db
              .select(accountSafeColumns)
              .from(accounts)
              .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
          (rows) => rows[0] ?? null,
        ),

      /** 补录/再水合:整张 creds map 覆盖写入(占位被真值替换,见 P6.6.1 provideCredentials)。 */
      setCredentials: (id: string, creds: string): Effect.Effect<void> =>
        Effect.asVoid(
          database.query((db) =>
            db
              .update(accounts)
              .set({ creds })
              .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
        ),

      /** 取原始 creds map(JSON 字符串,含 secret 密文)供 sync 解密 / 服务端投影用(内部接口,绝不裸出网)。 */
      getRawCreds: (id: string): Effect.Effect<string | null> =>
        Effect.map(
          database.query((db) =>
            db
              .select({ creds: accounts.creds })
              .from(accounts)
              .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
          (rows) => rows[0]?.creds ?? null,
        ),

      listRawCreds: (): Effect.Effect<AccountRawCreds[]> =>
        database.query((db) =>
          db
            .select({ id: accounts.id, creds: accounts.creds })
            .from(accounts)
            .where(eq(accounts.userId, userId)),
        ),

      rename: (id: string, label: string): Effect.Effect<void> =>
        Effect.asVoid(
          database.query((db) =>
            db
              .update(accounts)
              .set({ label })
              .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
        ),

      /** 归档/取消归档:archived=true 写当前时刻,false 置 null。可逆,不删数据。 */
      setArchived: (id: string, archived: boolean): Effect.Effect<void> =>
        Effect.asVoid(
          database.query((db) =>
            db
              .update(accounts)
              .set({ archivedAt: archived ? Date.now() : null })
              .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
        ),

      /** 删账户:其 snapshots / portfolio_accounts / manual_activity 经 ON DELETE CASCADE 级联删除。 */
      remove: (id: string): Effect.Effect<void> =>
        Effect.asVoid(
          database.query((db) =>
            db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
          ),
        ),
    };
  });

export class AccountStore extends Effect.Service<AccountStore>()("db/AccountStore", {
  effect: make,
}) {}
