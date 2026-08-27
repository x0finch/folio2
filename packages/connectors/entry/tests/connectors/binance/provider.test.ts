import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { binanceProvider } from "../../../src/connectors/binance/provider";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnLocked from "./fixtures/earn-locked.json";
import fundingAssets from "./fixtures/funding-assets.json";
import futuresAccount from "./fixtures/futures-account.json";

// **打桩打在 `HttpClient` 服务上,不再是 `globalThis.fetch`。**
//
// 老那版只能打全局 fetch —— provider 自己 new 了传输层,没有别的缝。现在出网是 `R` 通道上的一个
// 服务,测试 provide 一个假的即可,而且**这就是生产走的那条路**(装配那头 provide 的是
// `FolioHttpClient`)。顺带:`runClient` 还带上 `TestClock` 与进程内的限频档,签名里的 timestamp
// 因此是确定的,限频桶也不会跨用例串味。
const PRICES: Record<string, string> = { BTCUSDT: "60000", ETHUSDT: "3000" };
const tickerBody = Object.entries(PRICES).map(([symbol, price]) => ({ symbol, price }));

// 按 pathname 分派的假上游。给什么就回什么,没给的按「空账户」回 —— 于是每个用例只写它关心的那几个。
function upstream(routes: Record<string, () => Response>): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/dapi/v1/account")) return json({ assets: [], positions: [] });
    if (path.includes("/fapi/v2/account")) return json({ totalMarginBalance: "0", positions: [] });
    if (path.includes("/api/v3/account")) return json({ balances: [] });
    // **理财端点回的是翻页信封,不是数组** —— 以前这里一律回 `[]`,而 client 那时不校验形状,
    // 于是 `page.rows ?? []` 悄悄兜住了。换成 schema 之后它当场变成 parse 失败,
    // 也就把这个桩一直在撒的谎揪了出来。
    if (path.includes("/simple-earn/")) return json({ rows: [], total: 0 });
    if (path.includes("/sapi/")) return json([]);
    return json(tickerBody); // /api/v3/ticker/price
  });
}

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<typeof binanceProvider.fetchBalances>[0];
const ctx = (
  creds: Record<string, string> = { apiKey: "k", secret: "s" },
  providerCreds: Record<string, string> = {},
): Ctx =>
  ({
    account: { id: "a1", label: "Binance", connectorId: "binance", creds },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);

const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("签 /api/v3/account(带 apiKey 头 + signature)、取公开价表,再解析", async () => {
    const stub = upstream({ "/api/v3/account": () => json(account) });
    const { balances } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "ETH", "USDT", "NOPRICE"]);
    // per-balance note:ETH 有 locked=1 → 它自己那笔挂 Locked note。
    expect(balances.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "1 ETH · 33%",
    });

    const signed = stub.calls.find((c) => c.request.url.pathname.includes("/api/v3/account"));
    expect(signed?.request.url.searchParams.get("signature")).toBeTruthy();
    expect(signed?.request.headers["x-mbx-apikey"]).toBe("k");
  });

  it("429 → 限流;401 → 凭据问题", async () => {
    const limited = httpStub(() => json({}, { status: 429, headers: { "retry-after": "2" } }));
    expect((await failing(limited, binanceProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorRateLimitError",
    );
    const denied = httpStub(() => json({}, { status: 401 }));
    expect((await failing(denied, binanceProvider.fetchBalances(ctx())))._tag).toBe(
      "ConnectorAuthError",
    );
  });

  it("五个钱包全成功 → 合并 spot + perp 行(尽力而为全绿,无 Note)", async () => {
    const stub = upstream({
      "/sapi/v1/simple-earn/flexible/position": () => json(earnFlexible),
      "/sapi/v1/simple-earn/locked/position": () => json(earnLocked),
      "/sapi/v1/asset/get-funding-asset": () => json(fundingAssets),
      "/dapi/v1/account": () => json(coinmAccount),
      "/fapi/v2/account": () => json(futuresAccount),
      "/api/v3/account": () => json(account),
    });
    const { balances, note } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(8); // 现货 4 + 资金 2 + 理财 2
    expect(balances.filter((b) => b.kind === "perp_equity")).toHaveLength(2); // U 本位 + 币本位
    expect(balances.filter((b) => b.kind === "perp_position")).toHaveLength(4); // 各 2 持仓
    expect(note).toBeUndefined();
  });

  it("理财持仓 > 一页 → 翻页取全,靠后的 UNI/USDT 不丢", async () => {
    // 翻页现在在 client 里,但**这条断言留在这**:它钉的是「用户的币不会丢」,那是产品行为,
    // 不是「client 的翻页循环写对了」。两边各测各的不算重复 —— 中间那一跳换了实现,正是要看它。
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      asset: `A${i}`,
      totalAmount: "1",
      latestAnnualPercentageRate: "0.01",
    }));
    const page2 = [
      { asset: "UNI", totalAmount: "5", latestAnnualPercentageRate: "0.02" },
      { asset: "USDT", totalAmount: "100", latestAnnualPercentageRate: "0.03" },
    ];
    const stub = httpStub((request) => {
      const { pathname, searchParams } = request.url;
      if (pathname.includes("/simple-earn/flexible/position")) {
        return json({ rows: searchParams.get("current") === "2" ? page2 : page1, total: 102 });
      }
      if (pathname.includes("/simple-earn/locked/position")) return json({ rows: [], total: 0 });
      if (pathname.includes("/sapi/")) return json([]);
      if (pathname.includes("/dapi/v1/account")) return json({ assets: [], positions: [] });
      if (pathname.includes("/fapi/v2/account")) {
        return json({ totalMarginBalance: "0", positions: [] });
      }
      if (pathname.includes("/api/v3/account")) return json({ balances: [] });
      return json([{ symbol: "UNIUSDT", price: "10" }]);
    });

    const { balances } = await run(stub, binanceProvider.fetchBalances(ctx()));
    const earn = balances.filter((b) => b.note?.group === "earn");
    expect(earn).toHaveLength(102);
    expect(earn.some((b) => b.symbol === "UNI")).toBe(true);
    expect(earn.some((b) => b.symbol === "USDT")).toBe(true);
  });

  it("某个钱包失败(没勾 Futures → 401)→ 其余照返回 + 账户级 Note,不整账户失败", async () => {
    const stub = upstream({
      "/fapi/v2/account": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
    });
    const { balances, note } = await run(stub, binanceProvider.fetchBalances(ctx()));

    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(4);
    expect(balances.some((b) => b.kind !== "spot")).toBe(false);
    expect(note?.[0]?.title).toBe("Wallets not synced");
    expect(String(note?.[0]?.content)).toContain("Futures");
  });

  it("**Note 点名的是真失败的那个钱包**,不是按下标猜的", async () => {
    // 只让「资金」这一个失败 —— 它在 WALLETS 里排第四。用 `Effect.partition` 写的话成败两个数组
    // 不带下标,名字就得靠推;这条钉住的是「结果和它的 wallet 绑在一起出来」。
    const stub = upstream({
      "/sapi/v1/asset/get-funding-asset": () => json({}, { status: 500 }),
      "/api/v3/account": () => json(account),
    });
    const { note } = await run(stub, binanceProvider.fetchBalances(ctx()));
    expect(String(note?.[0]?.content)).toContain("Funding");
    expect(String(note?.[0]?.content)).not.toContain("Spot");
    expect(String(note?.[0]?.content)).not.toContain("Earn");
  });

  // —— 价表(FOL-30)——
  //
  // 价表是**四个钱包共用的估值原料**(现货 / 币本位 / 资金 / 理财 join 它,U 本位自带 USD 不 join)。
  // 它挂掉时若继续走「尽力而为」,写出去的就是一份只剩 U 本位的快照,把那四个钱包的真实资产
  // 整块盖掉 —— 生产上正是这样:note 恒为「Spot / COIN-M / Funding / Earn」,资产每小时掉块。
  // 所以它不是钱包失败,是**这一轮拿不到料**:整账户失败 → 交给 sync 的退避重试 → 打光则不写快照。
  it("**价表挂了 → 整账户失败**(可重试),不写一份只剩 U 本位合约的部分快照", async () => {
    const stub = upstream({
      "/api/v3/ticker/price": () => json({}, { status: 429 }),
      "/api/v3/account": () => json(account),
      "/fapi/v2/account": () => json(futuresAccount),
      "/dapi/v1/account": () => json(coinmAccount),
    });
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));

    // 限流 → 等一等会好,归可重试;绝不能以「成功但少四个钱包」的形状返回。
    expect(err._tag).toBe("ConnectorRateLimitError");
    expect(isRetryable(err)).toBe(true);
  });

  it("价表挂 + 某个钱包也挂 → 仍是整账户失败,价表优先于尽力而为", async () => {
    const stub = upstream({
      "/api/v3/ticker/price": () => json({}, { status: 503 }),
      "/fapi/v2/account": () => json({}, { status: 401 }),
      "/api/v3/account": () => json(account),
    });
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));
    expect(isRetryable(err)).toBe(true);
  });

  it("**全军覆没 → 失败**,不拿一份空快照盖掉已有余额", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, binanceProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("PC 只声明三个 base URL 覆盖 key(env 注入用,不是账户凭据)", () => {
    expect(binanceProvider.id).toBe("binance");
    expect(binanceProvider.creds.map((f) => f.key)).toEqual([
      "BINANCE_API_BASE",
      "BINANCE_FAPI_BASE",
      "BINANCE_DAPI_BASE",
    ]);
    // 全 public(不加密 / 不导出),且不进 UI 表单(表单只认 account.creds)。
    expect(binanceProvider.creds.every((f) => f.type === "public")).toBe(true);
  });

  // #264:出口 IP 被地区封时,app 从 env 把代理 base 注入 ctx.creds。适配层只把它当不透明整串
  // 递给 client,三个 host 各走各的;不设即直连。反查:默认 host 一个不留。
  it("三个 base 覆盖各自生效,默认 host 一个不留", async () => {
    const stub = upstream({});
    await run(
      stub,
      binanceProvider.fetchBalances(
        ctx(
          { apiKey: "k", secret: "s" },
          {
            BINANCE_API_BASE: "https://px.example/s/binance",
            BINANCE_FAPI_BASE: "https://px.example/s/binance-fapi",
            BINANCE_DAPI_BASE: "https://px.example/s/binance-dapi",
          },
        ),
      ),
    );

    const urls = stub.calls.map((c) => c.request.url.href);
    const hit = (prefix: string) => urls.some((u) => u.startsWith(prefix));
    expect(hit("https://px.example/s/binance/api/v3/account")).toBe(true);
    expect(hit("https://px.example/s/binance/api/v3/ticker/price")).toBe(true);
    expect(hit("https://px.example/s/binance-fapi/fapi/v2/account")).toBe(true);
    expect(hit("https://px.example/s/binance-dapi/dapi/v1/account")).toBe(true);
    expect(urls.some((u) => u.includes("binance.com"))).toBe(false);
  });
});

// 契约(#240):凭据被拒 → 成功返回 `false`;够不到上游 → 走错误通道,让调用方重试。
// 缺 creds 的守卫不在这里测 —— `validateAccount` 恒在 `validateCredentials` 之后调。
describe("validateAccount", () => {
  it("200 → true", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(true);
  });

  it("凭据被拒(401)→ false,不进错误通道", async () => {
    const stub = httpStub(() => json({}, { status: 401 }));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(false);
  });

  // binance 用 HTTP 400 表达错 secret(-1022)/ key 格式非法(-2014)—— 凭据问题,不该重试、
  // 也不该拿着错凭据再打一次上游(#240)。归「凭据问题」→ false。
  it("签名被拒(400)→ false,而且只发一次", async () => {
    const stub = httpStub(() => json({ code: -1022, msg: "Signature invalid" }, { status: 400 }));
    expect(await run(stub, binanceProvider.validateAccount(ctx()))).toBe(false);
    expect(stub.calls).toHaveLength(1);
  });

  it("429 → 限流(可重试),不压成 false", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    const err = await failing(stub, binanceProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorRateLimitError");
    expect(isRetryable(err)).toBe(true);
  });

  it("5xx → 够不到上游(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, binanceProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });
});
