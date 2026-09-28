import type { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { floorToHour, GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import { handleListAccounts } from "@/lib/server/accounts/list";
import type { AppError } from "@/lib/server/errors";
import { handleGetTokenValueHistory } from "@/lib/server/holdings/history";
import { createManualAccount } from "@/lib/server/manual/store";
import { handleGetManualAccount } from "@/lib/server/manual-tokens/get-account";
import { NAMER } from "@/lib/server/oracle";
import { handleGetFiatRefs } from "@/lib/server/portfolio/fiat-refs";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { handleResolvePlatformMeta } from "@/lib/server/portfolio/platform-meta";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import type { UserServices } from "@/lib/server/runtime";
import { handleGetDataStats } from "@/lib/server/settings/data-stats";
import { handleGetProviderKeyStatus } from "@/lib/server/settings/provider-keys";
import { handleGetValuationSettings } from "@/lib/server/settings/valuation";
import { handleGetSyncRound } from "@/lib/server/sync/round";
import { handleGetPortfolioTabPins } from "@/lib/server/tab-pins/read";
import { handleListAccountTags } from "@/lib/server/tags/account-tags";
import { handleListTags } from "@/lib/server/tags/list";
import { handleListTokenCatalogue } from "@/lib/server/tokens/catalogue";
import { handleGetTokenEnrichment } from "@/lib/server/tokens/enrichment";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { db } from "./_kit/db";
import { blockOutbound, type Outbound } from "./_kit/outbound";
import { call, callExit } from "./_kit/run";
import { DAY, HOUR, seedAccount, seedSnapshot } from "./_kit/seed";
import { freshUser } from "./_kit/user";
import { ticketOf } from "./ticket";

// **读接口不出网**(FOL-92)。
//
// 免费档一请求只有 10ms CPU,而一次上游往返光是建连、编解码就吃掉一截,还会把「页面打开要多久」
// 绑在别人家的延迟上。读路径的约定是:价格 / 名字 / logo 都读本地缓存(cron 与同步负责暖),
// 请求里不去取。这个文件把约定钉成断言:**每一个 GET server fn**,在「任何外呼都抛错」的
// fetch 底下跑一遍,一发都不许有。
//
// 「每一个」是从源码数出来的(下面的 `GET_SERVER_FNS`),不是这张表自己说了算 —— 新加一个
// GET server fn 而没在这里登记,第一条用例就红。
//
// **例外只有两类,各写理由**:
//   · 天生交互式的(`ALLOWED`):用户在选币 / 录入的那一刻要一个上游的答案,本地没有也不该有。
//   · 冷缓存按需填一次(`COLD_CACHE_FILL`):见那张表上面的注释;它也被反向钉住(必须真的还在出网)。
//
// 手记账户的历史价以前是第三类(读的时候按账本 × 历史日价现算,日价缺了去上游补)。FOL-90 把补日价
// 挪进了队列的 `daily-prices` 活、读端点只读表,那张豁免表随之删掉 —— 下面「有手记账户」那个场景
// 现在与纯同步账户同一个口径。

const GET_SERVER_FNS = (() => {
  const sources = import.meta.glob("../../src/lib/server/**/index.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const names = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/export const (\w+) = createServerFn\(\{ method: "GET" \}\)/g)) {
      names.add(m[1]);
    }
  }
  return names;
})();

/** 天生交互式的读:本地没有、也不该有答案。 */
const ALLOWED: Record<string, string> = {
  listTokens: "选币下拉的搜索:按用户敲的字去上游搜币,结果本来就不在本地。",
  getTokenPrice: "录入手记持仓时点「填入市价」的那一下:用户当场要一个上游现价。",
};

/**
 * **冷缓存按需填一次**:缓存没有时读接口自己去上游取一次、写进缓存,之后的读命中缓存。
 * 汇率那两条(`listFiatOptions` / `getCurrencyPreference`)FOL-88 已改成只读缓存(队列的 `fx` 活
 * 每小时暖),不在这里了。
 *
 * 剩下的 `listTokenCatalogue` **刻意留着**:选币下拉的默认列只有这一份数据,而暖它的 `catalogue` 活
 * 每天才投一次(FOL-88)—— 改成只读缓存的话,新用户在第一次 cron 之前打开「添加手记持仓」会看到一个
 * 空的默认列(搜索仍走上游)。它不在首页 / 账户页 / 洞察页的数据路径上,只在用户自己点开下拉时跑,
 * 而且冷缓存那一取之后 `user_cache` 过期不删,一个用户一辈子只会冷一次。
 */
const COLD_CACHE_FILL: Record<string, string> = {
  listTokenCatalogue:
    "选币目录(市值前 N 名):目录缓存 / 边缘缓存都冷时取一次 CoinGecko /coins/markets。",
};

/** 不经 Effect 运行时、也碰不到任何上游,在这里跑不起来的(理由写清楚,不是漏测)。 */
const NOT_RUN_HERE: Record<string, string> = {
  getSession:
    "better-auth 读会话(cookie + D1),要一个真实请求的 headers;没有出网路径。由 require-auth 用例覆盖。",
  listConnectors: "内联在 connectors/index.ts,只读静态的 ConnectorRegistry.catalog。",
  getConnectorCredentialSpecs: "内联在 connectors/index.ts,只读静态的 ConnectorRegistry.specs。",
};

type Run = () => Effect.Effect<unknown, AppError, UserServices>;

interface Fixture {
  portfolioId: string;
  syncedId: string;
  manualId?: string;
}

const NOW = floorToHour(Date.now());
const BTC = "token-btc";

/** 每个 GET server fn 的一组(或几组)代表性调用。键 = 用例名,`fn` = 源码里的 server fn 名。 */
const cases = (f: Fixture): { name: string; fn: string; run: Run }[] => [
  { name: "listPortfolios", fn: "listPortfolios", run: () => handleListPortfolios() },
  {
    name: "getManualAccount",
    fn: "getManualAccount",
    run: () => handleGetManualAccount({ accountId: f.manualId ?? f.syncedId }),
  },
  { name: "getSnapshots(now)", fn: "getSnapshots", run: () => handleGetSnapshots({ at: NOW }) },
  {
    name: "getSnapshots(prev)",
    fn: "getSnapshots",
    run: () => handleGetSnapshots({ at: NOW - GAIN_WINDOW_MS, after: NOW - GAIN_START_FLOOR_MS }),
  },
  { name: "getFiatRefs", fn: "getFiatRefs", run: () => handleGetFiatRefs({}) },
  {
    name: "resolvePlatformMeta",
    fn: "resolvePlatformMeta",
    run: () => handleResolvePlatformMeta({ chainIds: ["bitcoin", "ethereum"] }),
  },
  {
    name: "getPortfolioHistory(7d)",
    fn: "getPortfolioHistory",
    run: () => handleGetPortfolioHistory({ range: "7d" }),
  },
  {
    name: "getPortfolioHistory(30d)",
    fn: "getPortfolioHistory",
    run: () => handleGetPortfolioHistory({ range: "30d" }),
  },
  {
    name: "getPortfolioHistory(1y)",
    fn: "getPortfolioHistory",
    run: () => handleGetPortfolioHistory({ range: "1y" }),
  },
  { name: "getDataStats", fn: "getDataStats", run: () => handleGetDataStats() },
  {
    name: "getValuationSettings",
    fn: "getValuationSettings",
    run: () => handleGetValuationSettings(),
  },
  {
    name: "getTokenValueHistory(30d)",
    fn: "getTokenValueHistory",
    run: () => handleGetTokenValueHistory({ key: BTC, range: "30d", since: NOW - 30 * DAY }),
  },
  {
    name: "getTokenValueHistory(all)",
    fn: "getTokenValueHistory",
    run: () => handleGetTokenValueHistory({ key: BTC, range: "all" }),
  },
  {
    name: "getPortfolioTabPins",
    fn: "getPortfolioTabPins",
    run: () => handleGetPortfolioTabPins(),
  },
  {
    name: "getCurrencyPreference",
    fn: "getCurrencyPreference",
    run: () => handleGetCurrencyPreference({ code: "EUR" }),
  },
  {
    name: "getSyncRound",
    fn: "getSyncRound",
    run: () => handleGetSyncRound({ portfolioId: f.portfolioId }),
  },
  { name: "listTokenCatalogue", fn: "listTokenCatalogue", run: () => handleListTokenCatalogue() },
  { name: "getTokenEnrichment", fn: "getTokenEnrichment", run: () => handleGetTokenEnrichment() },
  {
    name: "listFiatOptions",
    fn: "listFiatOptions",
    run: () => handleListFiatOptions({ locale: "en" }),
  },
  { name: "listAccounts", fn: "listAccounts", run: () => handleListAccounts({}) },
  {
    name: "getAccountHistory(synced)",
    fn: "getAccountHistory",
    run: () =>
      handleGetAccountHistory({ accountId: f.syncedId, connectorId: "bitcoin", range: "30d" }),
  },
  ...(f.manualId
    ? [
        {
          name: "getAccountHistory(manual)",
          fn: "getAccountHistory",
          run: () =>
            handleGetAccountHistory({
              accountId: f.manualId as string,
              connectorId: "manual",
              range: "30d",
            }),
        },
      ]
    : []),
  { name: "listTags", fn: "listTags", run: () => handleListTags({}) },
  { name: "listAccountTags", fn: "listAccountTags", run: () => handleListAccountTags({}) },
];

// getProviderKeyStatus 只读 env(不是 Effect):直接调,同样在断网的 fetch 底下。
const plainCases: { name: string; fn: string; run: () => unknown }[] = [
  { name: "getProviderKeyStatus", fn: "getProviderKeyStatus", run: handleGetProviderKeyStatus },
];

const USER = "h-no-egress";

/** 逐个跑,记下每一个用例打出去的 URL(失败的 handler 也算 —— 要的是「有没有出网」)。 */
const egressByCase = async (outbound: Outbound, f: Fixture): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>();
  for (const c of cases(f)) {
    const before = outbound.calls.length;
    await callExit(USER, c.run());
    out.set(c.name, outbound.calls.slice(before));
  }
  for (const c of plainCases) {
    const before = outbound.calls.length;
    c.run();
    out.set(c.name, outbound.calls.slice(before));
  }
  return out;
};

const seedSynced = async (): Promise<Fixture> => {
  const acc = await seedAccount(USER, "冷钱包", "bitcoin");
  // 两个月逐日 + 最近一天逐小时:短窗、日汇总、长窗三条读路都有料。
  for (let d = 60; d >= 1; d--) {
    await seedSnapshot(USER, acc.id, NOW - d * DAY, [
      { tokenId: BTC, amount: 1, usdValue: 100 + d, platform: "bitcoin" },
    ]);
  }
  for (let h = 23; h >= 0; h--) {
    await seedSnapshot(USER, acc.id, NOW - h * HOUR, [
      { tokenId: BTC, amount: 1, usdValue: 200 + h, platform: "bitcoin" },
    ]);
  }
  const pf = await db(USER).portfolios.ensureDefault();
  return { portfolioId: pf.id, syncedId: acc.id };
};

describe("GET server fn 不出网(FOL-92)", () => {
  let outbound: Outbound;
  beforeEach(async () => {
    outbound = blockOutbound();
    await freshUser(USER);
  });

  it("每一个 GET server fn 都在这里登记了(源码里数出来的)", () => {
    const covered = new Set([
      ...cases({ portfolioId: "p", syncedId: "a", manualId: "m" }).map((c) => c.fn),
      ...plainCases.map((c) => c.fn),
      ...Object.keys(ALLOWED),
      ...Object.keys(NOT_RUN_HERE),
    ]);
    // 冷缓存那几条也必须真的在上面跑着(它们只是被豁免出网,不是不测)。
    expect(Object.keys(COLD_CACHE_FILL).filter((n) => !covered.has(n))).toEqual([]);
    expect(GET_SERVER_FNS.size).toBeGreaterThan(20);
    expect([...GET_SERVER_FNS].filter((n) => !covered.has(n)).sort()).toEqual([]);
    // 例外表里不许有不存在的名字(改名 / 删掉之后留下的豁免就是一个洞)。
    const stale = [...Object.keys(ALLOWED), ...Object.keys(NOT_RUN_HERE)].filter(
      (n) => !GET_SERVER_FNS.has(n),
    );
    expect(stale).toEqual([]);
  });

  it("只有同步账户:一发都没有", async () => {
    const f = await seedSynced();
    const egress = await egressByCase(outbound, f);
    const offenders = [...egress].filter(
      ([name, urls]) => urls.length > 0 && !(name in COLD_CACHE_FILL),
    );
    expect(offenders).toEqual([]);
    // 反过来也钉住:冷缓存豁免的每一条**现在确实还在出网**。哪天它改成只读缓存、不再出网,
    // 这里会红 —— 那时把豁免删掉,别让它变成一个没人记得的洞。
    const stillFetching = Object.keys(COLD_CACHE_FILL).filter(
      (n) => (egress.get(n)?.length ?? 0) > 0,
    );
    expect(stillFetching.sort()).toEqual(Object.keys(COLD_CACHE_FILL).sort());
  }, 120_000);

  // 手记账户(FOL-90 起):24 小时前那一端、组合曲线 7d/30d/1y、手记账户抽屉的曲线都按账本 × 表里的
  // 历史日价算,缺了就缺(队列的 `daily-prices` 活去补),读的时候不出网。
  it("再加一个手记账户:同样一发都没有(历史日价只读表)", async () => {
    const f = await seedSynced();
    // 选了币的手记持仓(带 CoinGecko 身份):它才有「上游历史价」可取 —— FOL-90 之前那条路会在这里出网。
    const manual = await call(
      USER,
      createManualAccount(
        "手记",
        JSON.stringify([
          { symbol: "BTC", unitPrice: 50_000, amount: 0.1, ticket: ticketOf("bitcoin") },
        ]),
      ),
    );
    // 补一笔 40 天前的开仓,让「24 小时前」与曲线那几条真的要按账本回算过去。
    const [holding] = await db(USER).manual.listHoldings(manual.id, NAMER);
    await db(USER).manual.recordActivity(manual.id, holding.id, {
      kind: "set",
      amount: 600,
      price: 1,
      occurredAt: NOW - 40 * DAY,
    });
    outbound.calls.length = 0;
    const egress = await egressByCase(outbound, { ...f, manualId: manual.id });
    const offenders = [...egress].filter(
      ([name, urls]) => urls.length > 0 && !(name in COLD_CACHE_FILL),
    );
    expect(offenders).toEqual([]);
    // 手记那几条确实跑到了(没有手记账户时它们走的是另一条路,零出网不说明什么)。
    expect(egress.has("getAccountHistory(manual)")).toBe(true);
  }, 120_000);
});
