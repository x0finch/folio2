import { PortfolioStore } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";
import { runStore } from "../oracle";
import { requireAuth } from "../session/require-auth";
import { handleListAccountHoldings } from "./account-holdings";
import { handleGetAccountGain24h, handleGetPortfolioGain24h } from "./gain";
import { handleGetPortfolioHistory } from "./get-history";
import { handleGetPortfolioOverview } from "./overview";
import { handleGetHomeTabStrip } from "./tabs";

// portfolio 资源面(读模型):只做装配,实现在同目录 RESTful 文件里(共享装配在 ./scope)。

// 选中 Portfolio 入参:客户端选择器传的临时选中 id(可空 → 用默认)。缺省 {} 让 loader 不带参调用时退回默认视图。
// 仅按选中 Portfolio scope(曲线 / 列表默认口径);不带 pin。
const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// overview 入参:在选中 Portfolio 之上再叠一个自定义 Tab 的 pin(ADR 0034)—— 按 connector/tag/account
// 在选中 Portfolio 内再收窄;缺省 = 默认视图(不收窄)。pin 只收窄 overview 的列表,不进曲线(见 getPortfolioHistory)。
const TabPinScope = z
  .object({
    kind: z.enum(["connector", "tag", "account"]),
    connectorId: z.string().optional(),
    tagId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .optional();
const PortfolioScopeInput = z
  .object({ portfolioId: z.string().optional(), pin: TabPinScope })
  .default({});

export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(handleGetPortfolioOverview);

export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(handleGetPortfolioGain24h);

export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(handleGetHomeTabStrip);

export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleListAccountHoldings);

export const getAccountGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(handleGetAccountGain24h);

export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(handleGetPortfolioHistory);

// —— Portfolio 管理(选择器 + 抽屉「移到 Portfolio」用,ADR 0033)——

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefaultPortfolio 保证至少有默认那行。
export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [portfolios, defaultPf] = await runStore(context.userId, PortfolioStore, (s) =>
      Effect.all([s.list(), s.ensureDefault()], { concurrency: 2 }),
    );
    return {
      portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
      defaultId: defaultPf.id,
    };
  });

// 把账户移到某 Portfolio:传 portfolioId 移到既有,或传 newName 一步「新建命名 Portfolio + 归属」
// (抽屉「移到 → 新建…」)。至少给其一。返回归属到的 portfolioId(客户端据此可切换选中)。
const MoveAccountInput = z
  .object({
    accountId: z.string().min(1),
    portfolioId: z.string().min(1).optional(),
    newName: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.portfolioId != null || v.newName != null, {
    message: "portfolioId or newName required",
  });
export const moveAccountToPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(MoveAccountInput)
  .handler(async ({ data, context }) => {
    // 建 Portfolio + 归属**一次装配**:它们本来就是一步操作的两半。
    const targetId = await runStore(context.userId, PortfolioStore, (s) =>
      Effect.gen(function* () {
        const id = data.newName
          ? (yield* s.create({ name: data.newName })).id
          : // biome-ignore lint/style/noNonNullAssertion: refine 保证 portfolioId 或 newName 至少其一
            data.portfolioId!;
        yield* s.assignAccount(data.accountId, id);
        return id;
      }),
    );
    return { portfolioId: targetId };
  });

// 新建命名 Portfolio(选择器/移到弹窗的「新建」页;只建、不归属 —— 建完回列表由用户再选,ADR 0033)。
export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ name: z.string().trim().min(1) }))
  .handler(async ({ data, context }) => {
    const pf = await runStore(context.userId, PortfolioStore, (s) => s.create({ name: data.name }));
    return { id: pf.id };
  });

// 该用户全部 账户→Portfolio 归属(账户页按选中 Portfolio 客户端过滤用 —— 账户页已加载全部账户,
// 拿归属表在客户端过滤即可、无需按选中重拉)。
export const listPortfolioMemberships = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runStore(context.userId, PortfolioStore, (s) => s.listMemberships()));

const PortfolioIdInput = z.object({ portfolioId: z.string().min(1) });

// 改名(含默认)。
export const renamePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput.extend({ name: z.string().trim().min(1) }))
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.rename(data.portfolioId, data.name));
    return { ok: true as const };
  });

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export const setDefaultPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.setDefault(data.portfolioId));
    return { ok: true as const };
  });

// 删除(默认不可删):成员退回默认后删该行。
export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.remove(data.portfolioId));
    return { ok: true as const };
  });
