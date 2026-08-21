import { env } from "cloudflare:test";
import type { SnapshotWithBalances } from "@folio/db";
import { globalTokenRefIndexStoreLayer, userCacheStoreLayer } from "@folio/db";
import { TokenService } from "@folio/oracle";
import { CacheStore, GlobalTokenRefIndexStore } from "@folio/oracle-basic/ports";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorPlatformMeta } from "../../src/lib/server/connectors/platform";
import { NAMER, runRequest } from "../../src/lib/server/oracle";
import { buildOverview } from "../../src/lib/server/portfolio/overview-model";
import { dbFor, withStore } from "./db-effect";
import {
  addManualActivities,
  createManualAccount,
  createToken,
  injectManualSnapshots,
} from "./manual-fns";
import { syncOne } from "./sync-fns";
import { ticketOf } from "./ticket";

// **按用户情景走一遍,每个情景查三处:入库 / 库里的数据对不对 / 屏幕上是什么。**
//
// 为什么要有这个文件:#223 / #227 里连着两个关键路径的 bug,现有测试一个都没抓到,而两次
// 漏掉的原因是同一个 —— **每个函数各自有测试,但没有一条测试从头走到尾**:
//
//   · 自定义币借了真币的价 —— `manual-t2` 测过 injectManualSnapshots,但夹具是**空缓存**,
//     于是「我们没去问」和「问了但没查到」这两件事在断言里长得一样,断言是空的。
//   · 选币的币没有 logo —— `manual-snapshot` 测过 buildManualSnapshot 的输出形状,却从不断言
//     `tokenId`;而没有任何测试看过**屏幕上那一行**长什么样。合成余额把 tokenId 传成 null,
//     两边各自的用例都绿。
//
// 结论:边界两侧各测一遍,挡不住「跨边界传错值」。所以这里一律**驱动真链路**:真 D1、
// 真 mint、真 `buildOverview`(= `getPortfolioOverview` 的组装),只把「取数」和「出网」打桩。
//
// 上游一律打桩成记账 + 抛错:这些路径按设计不出网,任何一次外呼都得看得见(断言之一)。

const USER = "user-scenarios";
const USDC_ID = "usd-coin";
const USDC_UPSTREAM = `${NAMER}/issued:${USDC_ID}`;
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MARKET_PRICE = 0.9998;

let outbound: string[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM global_token_ref_index").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`本情景不该出网,却请求了 ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// —— 查处 ③:屏幕上那一行 ——
// `getPortfolioOverview` 那个 server fn 的组装照抄一遍(它只有这几行:读账户/快照/设置 →
// 注入手记合成项 → buildOverview)。**不复刻业务逻辑**,所以顺序或依赖一改,这里会跟着红。
async function overview() {
  const [allAccounts, snapshots, settings] = await Promise.all([
    dbFor(USER).accounts.list(),
    dbFor(USER).snapshots.latest(),
    dbFor(USER).settings.get(),
  ]);
  const accounts = allAccounts.filter((a) => a.archivedAt == null);
  const byAccount = new Map<string, SnapshotWithBalances>(
    snapshots.map((s) => [s.snapshot.accountId, s]),
  );
  await injectManualSnapshots(USER, accounts, byAccount);
  // **真参考层**(真 D1 store + 真 CoinGecko adapter,出网被桩住)—— 与 server fn 逐字同款:
  // 一次 `runRequest` 供上 `TokenService` / `PlatformService`。
  return runRequest(
    USER,
    buildOverview(accounts, byAccount, {
      connectorMeta: connectorPlatformMeta,
      mode: settings.valuationMode,
    }),
  );
}

const holdingOf = (view: Awaited<ReturnType<typeof overview>>, symbol: string) =>
  view.holdings.find((h) => h.token.symbol === symbol);

// —— 查处 ①/②:库里的行 ——
async function tokenRows() {
  const { results } = await env.DB.prepare(
    "SELECT id, symbol, name, logo, unit_price AS unitPrice, self_price AS selfPrice FROM tokens WHERE user_id = ? ORDER BY symbol",
  )
    .bind(USER)
    .all<{
      id: string;
      symbol: string;
      name: string;
      logo: string | null;
      unitPrice: number | null;
      selfPrice: number | null;
    }>();
  return results;
}

async function refRows(tokenId: string) {
  const { results } = await env.DB.prepare(
    "SELECT namer, local_name AS localName FROM token_refs WHERE user_id = ? AND token_id = ? ORDER BY namer",
  )
    .bind(USER, tokenId)
    .all<{ namer: string; localName: string }>();
  return results;
}

// 让参考层「刷过一轮」。**驱动真的刷新路径**(`refreshStalePrices` + `refreshStaleInfo`),
// 只把 CoinGecko 的 HTTP 响应打桩 —— 不手写 `putInfo` 直塞。
//
// 这一条是有代价换来的:第一版就是手写直塞,结果把 `refreshStaleInfo` 整个绕开了,
// 「上游给的小写 symbol 有没有被归一」这件事在情景里根本没被碰到(实测:把归一删掉,12 条全绿)。
// 夹具绕过被测代码,断言就是空的 —— 与下面 `seedOldLayerUsdc` 那条注释同一个教训。
//
// 桩里的 symbol **故意是小写**(`usdc`),那就是 CoinGecko 真实的返回。
async function upstreamRefreshed(tokenId: string): Promise<void> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    outbound.push(url.pathname);
    const body = url.pathname.includes("/coins/markets")
      ? [
          {
            id: USDC_ID,
            symbol: "usdc", // ← 上游给小写
            name: "USDC",
            image: "https://cgk/usdc.png",
            current_price: MARKET_PRICE,
            market_cap_rank: 5,
            price_change_percentage_24h: 0.01,
            last_updated: new Date(Date.now()).toISOString(),
          },
        ]
      : url.pathname.includes("/simple/price")
        ? { [USDC_ID]: { usd: MARKET_PRICE, usd_24h_change: 0.01 } }
        : (() => {
            throw new Error(`桩没覆盖这个端点: ${url.pathname}`);
          })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await runRequest(
    USER,
    Effect.flatMap(TokenService, (tokens) => tokens.refreshStale([tokenId])),
  );
  // 刷完把桩换回「出网就抛」—— 后面的展示断言仍然要求零外呼。
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`本情景不该出网,却请求了 ${String(input)}`);
  });
}

// —— 情景一:在下拉里选了币 ——
describe("情景:手动加币,在下拉里选了 USDC", () => {
  const add = () =>
    createManualAccount(
      USER,
      "M",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "777", amount: "10", ticket: ticketOf(USDC_ID) },
      ]),
    );

  it("① 入库:一行代币,且**只挂上游那条 ref**", async () => {
    await add();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    // 选了币时 provider ref 与上游 ref 是同一个串 → 去重后只有一条(不然会撞主键)。
    expect(await refRows(rows[0].id)).toEqual([{ namer: NAMER, localName: `issued:${USDC_ID}` }]);
    expect(outbound).toEqual([]); // 写路径不出网
  });

  // 价**不落 tokens 那一列** —— 表单里填的开仓价进的是账本的第一笔(价只有账本一个来源)。
  it("② 数据:symbol 归一大写;开仓价落在账本上,tokens 那两列都空着", async () => {
    await add();
    const [row] = await tokenRows();
    expect(row.symbol).toBe("USDC"); // 不是票里那个小写的 coin id
    expect(row.selfPrice).toBeNull();
    expect(row.unitPrice).toBeNull(); // 上游还没刷过
    const { results } = await env.DB.prepare(
      "SELECT kind, price FROM manual_activity WHERE token_id = ?",
    )
      .bind(row.id)
      .all<{ kind: string; price: number | null }>();
    expect(results).toEqual([{ kind: "set", price: 777 }]);
  });

  it("③ 展示:上游刷过之后,用**市价**和上游的名字/图", async () => {
    await add();
    const [row] = await tokenRows();
    await upstreamRefreshed(row.id);

    const h = holdingOf(await overview(), "USDC");
    expect(h?.token.id).toBe(row.id); // 有身份 → 进了富化门
    // 图走**代理端点**,不是上游那个 URL(ADR 0008:不让浏览器去 CGK 的 CDN 拿图、泄露持仓)。
    expect(h?.token.logo).toBe(`/api/logo/token/${row.id}`);
    expect(h?.totalValue).toBeCloseTo(10 * MARKET_PRICE, 6); // 不是 10 × 777
    expect(outbound).toEqual([]); // 展示是 cache-only
  });

  // 两层缓存都没有这个币的价(全新用户、还没刷过任何一轮)→ 先用用户填的单价兜住,
  // 而不是显示 $0。刷过之后就该换成市价 —— 上一条钉的是那一档。
  it("③ 展示:两层都还没价 → 先用用户填的单价兜住,不显示 $0", async () => {
    await add();
    const h = holdingOf(await overview(), "USDC");
    expect(h?.totalValue).toBe(10 * 777);
  });
});

// —— 情景二:没选币,自己敲了一个同名的 ——
describe("情景:手动加币,不选、自己敲 USDC", () => {
  const add = () =>
    createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "USDC", unitPrice: "777", amount: "10" }]),
    );

  it("① 入库:一行代币,只挂 `manual/custom:` 那条,**没有**上游那条", async () => {
    await add();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(await refRows(rows[0].id)).toEqual([{ namer: "manual", localName: "custom:USDC" }]);
  });

  it("② 数据:开仓价在账本上,market 价永远空(没有上游可问)", async () => {
    await add();
    const [row] = await tokenRows();
    expect(row.selfPrice).toBeNull();
    expect(row.unitPrice).toBeNull();
    const { results } = await env.DB.prepare("SELECT price FROM manual_activity WHERE token_id = ?")
      .bind(row.id)
      .all<{ price: number | null }>();
    expect(results).toEqual([{ price: 777 }]);
  });

  // #223 的核心承诺,而且是从**屏幕**这一侧验的 —— 上一版只在写路径上成立,显示照旧按市价盯。
  it("③ 展示:用他填的价、没有 logo —— 哪怕参考层里摆着一个同名的真 USDC", async () => {
    await add();
    // 另开一个账户选真 USDC,让参考层里确实有一个刷过的、同名的、有价有图的币。
    await createManualAccount(
      USER,
      "Picked",
      JSON.stringify([{ symbol: "USDC", unitPrice: "1", amount: "1", ticket: ticketOf(USDC_ID) }]),
    );
    // 把「选出来的那一行」刷成有价有图 —— 两行都叫 USDC,靠 ref 行分辨谁是谁。
    let pickedId: string | undefined;
    let customId: string | undefined;
    for (const r of await tokenRows()) {
      const namer = (await refRows(r.id))[0]?.namer;
      if (namer === NAMER) pickedId = r.id;
      if (namer === "manual") customId = r.id;
    }
    expect(pickedId).toBeDefined();
    expect(customId).toBeDefined();
    await upstreamRefreshed(pickedId as string);

    const view = await overview();
    const custom = view.holdings.find((h) => h.token.id === customId);
    expect(custom?.totalValue).toBe(10 * 777); // 自己填的价
    expect(custom?.token.logo).toBeUndefined(); // 没借真 USDC 那张图
    // 对照:同一屏上那个真的确实有图有市价 —— 否则本条用「什么都没刷」也能绿。
    const picked = view.holdings.find((h) => h.token.id === pickedId);
    expect(picked?.token.logo).toBe(`/api/logo/token/${pickedId}`);
    expect(picked?.totalValue).toBeCloseTo(MARKET_PRICE, 6);
    expect(outbound).toEqual([]);
  });

  it("③ 展示:与选出来的那个真 USDC **不聚合** —— 两行", async () => {
    await add();
    await createManualAccount(
      USER,
      "Picked",
      JSON.stringify([{ symbol: "USDC", unitPrice: "1", amount: "1", ticket: ticketOf(USDC_ID) }]),
    );
    const view = await overview();
    expect(view.holdings.filter((h) => h.token.symbol === "USDC")).toHaveLength(2);
  });
});

// —— 情景二·下半:同一件事的**另一条写路径** ——
//
// 加币有三个入口,而上面只走了「新建手记账户」那一个:
//   ① createManualAccount —— 建账户时的首个币(表单有独立的「单价」字段)
//   ② createToken —— 抽屉里「加一个币」(也有单价字段)
//   ③ addManualActivities —— 抽屉里「记一笔活动」,顺带现建这个币(**没有**单价字段)
//
// ③ 是实际会踩坑的那条:表单里只有「成交价」,而单价靠选币之后异步回填市价 —— 手敲的币没有票,
// 那次回填不跑,unitPrice 恒 0。于是用户填了 888、列表里那一行却没有价(实测 SSGS)。
// 一条路测过不代表另两条也对,所以三条都要有。
describe("情景:手动加币的另两条写路径", () => {
  async function manualAccount() {
    const a = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1", ticket: ticketOf("bitcoin") }]),
    );
    return a.id;
  }

  it("② 抽屉里加币(createToken):自己敲名字 + 填单价 → 列表按那个价算", async () => {
    const accountId = await manualAccount();
    await createToken(USER, { accountId, symbol: "SSGS", unitPrice: 888, amount: 22 });

    const h = holdingOf(await overview(), "SSGS");
    expect(h?.totalValue).toBe(22 * 888);
  });

  // **本轮的 bug**:这条路的表单没有单价字段,只有成交价。
  // 注意查处 ② 的期望:`self_price` **保持 NULL** —— 不把成交价抄进去(抄进去就成了存派生值,
  // 第一笔抄了个 0 之后谁都治不好它)。价是展示时按链算出来的。
  it("③ 记一笔活动顺带现建币:库里不存价,屏幕上按成交价算", async () => {
    const accountId = await manualAccount();
    const res = await addManualActivities(USER, accountId, [
      {
        // 手敲的币:没有 ticket,所以前端那次「回填市价」压根不跑,unitPrice 只能是 0。
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 22,
        occurredAt: Date.now(),
        price: 888, // 用户唯一给出的数字
      },
    ]);
    expect(res.ok).toBe(true);

    const [row] = (await tokenRows()).filter((r) => r.symbol === "SSGS");
    expect(row.selfPrice).toBeNull(); // ② 库里:没声明过就是 NULL,不抄成交价进去
    const h = holdingOf(await overview(), "SSGS");
    expect(h?.totalValue).toBe(22 * 888); // ③ 屏幕:22 × 888,不是 $0
    expect(h?.token.logo).toBeUndefined(); // 手敲的币没有图
  });

  // 用户第二次加币的情形:再记一笔更新的成交价 → 当下值跟着走(以前它卡在 0 上治不好)。
  it("③ 再记一笔更新的成交价 → 当下值跟着最近那一笔", async () => {
    const accountId = await manualAccount();
    const base = Date.now();
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 22,
        occurredAt: base,
        price: 888,
      },
    ]);
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 1,
        occurredAt: base + 1,
        price: 999,
      },
    ]);
    expect(holdingOf(await overview(), "SSGS")?.totalValue).toBe(23 * 999);
  });

  // **价只有账本一个来源**,所以「最新那笔」永远说话 —— 哪怕它比开仓价低得多。
  // 这条替掉了先前那版「声明价优先、不被成交价盖掉」的用例:那时开仓价存在 `tokens.self_price`,
  // 于是同一件事两处存;现在开仓价就是账本的第一笔,后面的成交价是后面几笔,答案恒取最新。
  it("③ 开仓价也只是账本的一笔 —— 后来的成交价照样接管", async () => {
    const accountId = await manualAccount();
    await createToken(USER, { accountId, symbol: "SSGS", unitPrice: 888, amount: 10 });
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 1,
        occurredAt: Date.now() + 1,
        price: 1,
      },
    ]);
    const [row] = (await tokenRows()).filter((r) => r.symbol === "SSGS");
    expect(row.selfPrice).toBeNull(); // 库里那一列没人写了
    expect(holdingOf(await overview(), "SSGS")?.totalValue).toBe(11 * 1);
  });
});

// —— 情景三:链上钱包同步 ——
describe("情景:链上钱包同步到一笔 USDC", () => {
  const onchainBalance = {
    symbol: "USDC",
    amount: 5,
    value: 5,
    kind: "spot" as const,
    tokenRef: USDC_ETH,
  };

  async function syncOnchain(): Promise<string> {
    // 全局映射表收录了这个合约 → mint 按**地址**认出来(不靠 symbol)。
    await withStore(GlobalTokenRefIndexStore, globalTokenRefIndexStoreLayer, (s) =>
      s.putAll([{ chainRef: USDC_ETH, upstreamRef: USDC_UPSTREAM }], Date.now()),
    );
    // warm 集给 symbol 那一档留个本地候选,免得它想回源(本情景不该出网)。
    await withStore(CacheStore, userCacheStoreLayer({ userId: USER }), (s) =>
      s.put(
        "warm",
        {
          asOf: Date.now(),
          rows: [
            {
              info: { ref: USDC_UPSTREAM, symbol: "USDC", name: "USDC" },
              price: { unitPrice: MARKET_PRICE, marketCapRank: 5, asOf: Date.now() },
            },
          ],
        },
        60 * 60 * 1000,
      ),
    );
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "w",
      creds: null,
    });
    const res = await syncOne(USER, {
      account: (await dbFor(USER).accounts.list()).find((a) => a.id === account.id) as never,
      balances: [onchainBalance as never],
    });
    if (!res.ok || !res.snapshotId) throw new Error(`sync failed: ${res.error ?? "no snapshot"}`);
    return res.snapshotId;
  }

  it("① 入库:一行代币,挂**两条** ref —— 链上那条 + 上游那条", async () => {
    await syncOnchain();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(await refRows(rows[0].id)).toEqual([
      { namer: NAMER, localName: `issued:${USDC_ID}` },
      { namer: "evm:1", localName: "contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    ]);
  });

  it("② 数据:快照行的 token_id 指向那一行(身份写时定死)", async () => {
    const snapshotId = await syncOnchain();
    const [row] = await tokenRows();
    // symbol / token_ref 不再落快照(#243):身份只剩 token_id,反查上游叫法走 token_refs。
    const { results } = await env.DB.prepare(
      "SELECT token_id AS tokenId FROM snapshot_balances WHERE snapshot_id = ?",
    )
      .bind(snapshotId)
      .all<{ tokenId: string | null }>();
    expect(results).toEqual([{ tokenId: row.id }]);
  });

  it("③ 展示:刷过之后有上游的名字与图", async () => {
    await syncOnchain();
    const [row] = await tokenRows();
    await upstreamRefreshed(row.id);

    const h = holdingOf(await overview(), "USDC");
    expect(h?.token.logo).toBe(`/api/logo/token/${row.id}`);
    expect(h?.totalAmount).toBe(5);
  });

  // canonical 聚合的核心承诺:同一个币,链上的和手记选的,**并成一行**。
  it("③ 展示:与手记里选的同一个 USDC 聚合成一行,数量相加", async () => {
    await syncOnchain();
    await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "USDC", unitPrice: "1", amount: "10", ticket: ticketOf(USDC_ID) }]),
    );
    const rows = await tokenRows();
    expect(rows).toHaveLength(1); // 同一个上游 ref → 同一行,没建第二个
    await upstreamRefreshed(rows[0].id);

    const view = await overview();
    const usdc = view.holdings.filter((h) => h.token.symbol === "USDC");
    expect(usdc).toHaveLength(1);
    expect(usdc[0].totalAmount).toBe(15); // 5 链上 + 10 手记
    expect(usdc[0].sources).toHaveLength(2); // 两个来源各自可见
  });
});
