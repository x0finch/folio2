import { type AccountSafe, Database, type DbRequest, type PortfolioMembership } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { inView, type TabPinScope } from "@/lib/core/accounts-in-view";

// 选中 Portfolio 入参:客户端选择器传的临时选中 id(可空 → 用默认)。缺省 {} 让 loader 不带参调用时退回默认视图。
// 仅按选中 Portfolio scope(曲线 / 列表默认口径);不带 pin。
export const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// overview 入参:在选中 Portfolio 之上再叠一个自定义 Tab 的 pin(ADR 0034)—— 按 connector/tag/account
// 在选中 Portfolio 内再收窄;缺省 = 默认视图(不收窄)。pin 只收窄 overview 的列表,不进曲线(见 get-history)。
// pin 的 TS 形状家在 core/accounts-in-view 的 `TabPinScope`,不另造一份 —— 一致性由 .handler() 处的赋值检查看着。
export const PortfolioScopeInput = z
  .object({
    portfolioId: z.string().optional(),
    pin: z
      .object({
        kind: z.enum(["connector", "tag", "account"]),
        connectorId: z.string().optional(),
        tagId: z.string().optional(),
        accountId: z.string().optional(),
      })
      .optional(),
  })
  .default({});

export interface PortfolioScope {
  portfolioId?: string;
  pin?: NonNullable<TabPinScope>;
}

// 校验传入的 selectedId 属于该用户,否则退回默认(客户端传入不可信 —— 传别人的 id 只会得到空视图,
// 不泄露任何数据,但显式回退到默认更符合直觉)。返回选中 id + 默认 Portfolio。
//
// **一条查询**(FOL-92):默认那个就在列表里(`isDefault`),只有列表里找不到它(新用户第一次落地)
// 才走 `ensureDefault` 去建。以前每次都并发跑 `list` + `ensureDefault` 两条 —— 读路径上每条 D1 查询
// 都有一份固定的 Worker CPU,而几乎每个读接口都要先过这一步。
export const resolveScope = (
  requested: string | undefined,
): Effect.Effect<{ selectedId: string; defaultId: string }, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const store = (yield* Database).portfolios;
    const portfolios = yield* store.list();
    const defaultId = portfolios.find((p) => p.isDefault)?.id ?? (yield* store.ensureDefault()).id;
    const selectedId =
      requested && portfolios.some((p) => p.id === requested) ? requested : defaultId;
    return { selectedId, defaultId };
  });

// 当前组合的成员判据(ADR 0047:作用域在服务端定)。账户域那几个读取口共用这一份。
//
// **与归档无关** —— 账户页有归档区。用 `accountsInView` 那个口径(它排除归档,喂总览/曲线)会让
// 归档账户从账户页凭空消失。两个口径别混,判据是「这一页要不要显示归档」。
export interface ScopedMembership {
  selectedId: string;
  defaultId: string;
  /**
   * 该用户的**全部**账户(安全列,不按组合筛 —— 筛用 `has`)。顺带给出来是因为几乎每个调用方
   * 接下来都要它:账户与归属是同一条 join 查出来的(`accounts.listWithPortfolio`),不必再查一趟。
   */
  accounts: AccountSafe[];
  /** 账户 → 组合的归属行(`accountsInView` 那一族纯函数的原料)。 */
  memberships: PortfolioMembership[];
  /** 这个账户在不在当前组合的视图里(归档与否不影响)。 */
  has: (accountId: string) => boolean;
  /** 这个账户归属哪个组合 —— 没有归属行的按兜底规则算进默认组合(同 `inView`)。 */
  portfolioIdOf: (accountId: string) => string;
}

export const scopedMembership = (
  requested: string | undefined,
): Effect.Effect<ScopedMembership, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [{ selectedId, defaultId }, rows] = yield* Effect.all(
      [resolveScope(requested), db.accounts.listWithPortfolio()],
      { concurrency: 2 },
    );
    const portfolioOf = new Map<string, string>();
    const memberships: PortfolioMembership[] = [];
    const accounts: AccountSafe[] = [];
    for (const { portfolioId, ...account } of rows) {
      accounts.push(account);
      if (portfolioId != null) {
        portfolioOf.set(account.id, portfolioId);
        memberships.push({ accountId: account.id, portfolioId });
      }
    }
    return {
      selectedId,
      defaultId,
      accounts,
      memberships,
      has: (accountId) => inView(portfolioOf.get(accountId), selectedId, defaultId),
      portfolioIdOf: (accountId) => portfolioOf.get(accountId) ?? defaultId,
    };
  });
