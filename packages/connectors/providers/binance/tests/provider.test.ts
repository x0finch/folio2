import { ProviderError } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceProvider, parseAccountBalances } from "../src";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import earnFlexible from "./fixtures/earn-flexible.json";
import earnLocked from "./fixtures/earn-locked.json";
import expected from "./fixtures/expected-balances.json";
import fundingAssets from "./fixtures/funding-assets.json";
import futuresAccount from "./fixtures/futures-account.json";
import prices from "./fixtures/prices.json";

// 新 FetchContext 形状:account.creds(AC:apiKey/secret,由分派桥 openCreds 解密后灌入)+ creds(PC:
// base URL 覆盖,#264,由 app 从 env 注入;默认空 = 直连)。
type Ctx = Parameters<typeof binanceProvider.fetchBalances>[0];
function ctx(
  creds: Record<string, string> = { apiKey: "k", secret: "s" },
  providerCreds: Record<string, string> = {},
): Ctx {
  return {
    account: { id: "a1", label: "Binance", connectorId: "binance", creds },
    creds: providerCreds,
  } as unknown as Ctx;
}

afterEach(() => vi.restoreAllMocks());

// 两份 fixture 一一对应:account.json(录制的 /api/v3/account 响应)+ prices.json(行情价映射)
// → expected-balances.json(解析后的期望值)。覆盖:free+locked 合并、按价估值(稳定币≈1、
// 无交易对→0)、跳过零余额(BNB)。JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseAccountBalances (golden: fixtures in → fixture out)", () => {
  const balances = parseAccountBalances(account, prices);

  it("maps the recorded account + price map to expected-balances", () => {
    // per-balance note(note 重设计,单个 Note):ETH locked=1 → 它自己那笔挂 Locked note;其余无 note。
    expect(balances).toEqual(expected);
    // BNB has zero balance → excluded
    expect(balances.find((b) => b.symbol === "BNB")).toBeUndefined();
  });

  it("锁仓的币(ETH)自带 Locked note(数量口径 + 单位);无锁仓的币(BTC/USDT)无 note", () => {
    const eth = balances.find((b) => b.symbol === "ETH");
    expect(eth?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "1 ETH · 33%",
    });
    expect(balances.find((b) => b.symbol === "BTC")?.note).toBeUndefined();
    expect(balances.find((b) => b.symbol === "USDT")?.note).toBeUndefined();
  });

  it("跳过 LD 前缀理财份额(LDBNB,与 earn wallet 重复),但保留 LDO 等短币真币", () => {
    const rows = parseAccountBalances(
      {
        balances: [
          { asset: "LDBNB", free: "1", locked: "0" },
          { asset: "LDO", free: "2", locked: "0" },
          { asset: "BTC", free: "0.5", locked: "0" },
        ],
      },
      { LDOUSDT: 10, BTCUSDT: 60000 },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["LDO", "BTC"]);
  });
});

describe("binanceProvider.fetchBalances", () => {
  it("signs /api/v3/account (X-MBX-APIKEY + signature) + fetches public prices, then parses", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      // 合约钱包:空账户(此测试聚焦现货签名/估值;合约合并与尽力而为见下方专测)。
      if (u.includes("/dapi/v1/account"))
        return new Response(JSON.stringify({ assets: [], positions: [] }), { status: 200 });
      if (u.includes("/fapi/v2/account"))
        return new Response(JSON.stringify({ totalMarginBalance: "0", positions: [] }), {
          status: 200,
        });
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify(account), { status: 200 });
      return new Response(
        JSON.stringify([
          { symbol: "BTCUSDT", price: "60000" },
          { symbol: "ETHUSDT", price: "3000" },
        ]),
        { status: 200 },
      );
    });

    const { balances } = await binanceProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "ETH", "USDT", "NOPRICE"]);
    // per-balance note:ETH 有 locked=1 → 它自己那笔挂 Locked note。
    expect(balances.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Locked",
      icon: "warning",
      content: "1 ETH · 33%",
    });

    const acctCall = spy.mock.calls.find((c) => String(c[0]).includes("/api/v3/account?"));
    expect(acctCall).toBeDefined();
    expect(String(acctCall?.[0])).toContain("&signature=");
    expect((acctCall?.[1]?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe("k");
  });

  // 缺 key/secret 的拒绝已上移到分派桥的 validateCredentials(见 @folio/connectors-basic creds.test);
  // provider 信任已校验的 account.creds,故此处不再测"无请求即拒"。

  it("maps 429 → RATE_LIMITED with Retry-After, 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
    );
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 2000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(binanceProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("现货 + U本位 + 币本位全成功 → 合并 spot + perp 行(尽力而为全绿,无 Note)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/sapi/v1/simple-earn/flexible/position"))
        return new Response(JSON.stringify(earnFlexible), { status: 200 });
      if (u.includes("/sapi/v1/simple-earn/locked/position"))
        return new Response(JSON.stringify(earnLocked), { status: 200 });
      if (u.includes("/sapi/v1/asset/get-funding-asset"))
        return new Response(JSON.stringify(fundingAssets), { status: 200 });
      if (u.includes("/dapi/v1/account"))
        return new Response(JSON.stringify(coinmAccount), { status: 200 });
      if (u.includes("/fapi/v2/account"))
        return new Response(JSON.stringify(futuresAccount), { status: 200 });
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify(account), { status: 200 });
      return new Response(
        JSON.stringify([
          { symbol: "BTCUSDT", price: "60000" },
          { symbol: "ETHUSDT", price: "3000" },
        ]),
        { status: 200 },
      );
    });
    const { balances, note } = await binanceProvider.fetchBalances(ctx());
    // 现货 4 + 资金 2 + 理财 2(USDT 活期 + BTC 定期)
    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(8);
    // U本位 + 币本位各一个权益行
    expect(balances.filter((b) => b.kind === "perp_equity")).toHaveLength(2);
    // U本位 2 持仓 + 币本位 2 持仓
    expect(balances.filter((b) => b.kind === "perp_position")).toHaveLength(4);
    expect(note).toBeUndefined();
  });

  it("理财持仓 > 一页(size=100)→ 翻页取全,靠后的 UNI/USDT 不丢", async () => {
    // 第 1 页返回满 100 条(触发翻页),第 2 页才给 UNI/USDT —— 不翻页就会丢掉它们(#... 的病根)。
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      asset: `A${i}`,
      totalAmount: "1",
      latestAnnualPercentageRate: "0.01",
    }));
    const page2 = [
      { asset: "UNI", totalAmount: "5", latestAnnualPercentageRate: "0.02" },
      { asset: "USDT", totalAmount: "100", latestAnnualPercentageRate: "0.03" },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/sapi/v1/simple-earn/flexible/position")) {
        const rows = u.includes("current=2") ? page2 : page1;
        return new Response(JSON.stringify({ rows, total: 102 }), { status: 200 });
      }
      if (u.includes("/sapi/v1/simple-earn/locked/position"))
        return new Response(JSON.stringify({ rows: [], total: 0 }), { status: 200 });
      if (u.includes("/sapi/v1/asset/get-funding-asset"))
        return new Response(JSON.stringify([]), { status: 200 });
      if (u.includes("/dapi/v1/account"))
        return new Response(JSON.stringify({ assets: [], positions: [] }), { status: 200 });
      if (u.includes("/fapi/v2/account"))
        return new Response(JSON.stringify({ totalMarginBalance: "0", positions: [] }), {
          status: 200,
        });
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify({ balances: [] }), { status: 200 });
      return new Response(JSON.stringify([{ symbol: "UNIUSDT", price: "10" }]), { status: 200 });
    });

    const { balances } = await binanceProvider.fetchBalances(ctx());
    const earn = balances.filter((b) => b.note?.group === "earn");
    expect(earn).toHaveLength(102); // 100(第一页)+ 2(第二页)
    expect(earn.some((b) => b.symbol === "UNI")).toBe(true);
    expect(earn.some((b) => b.symbol === "USDT")).toBe(true);
  });

  it("合约端点失败(没勾 Futures → 401)→ 现货照返回 + 账户级 Note(不整账户失败)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/fapi/v2/account")) return new Response("", { status: 401 });
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify(account), { status: 200 });
      return new Response(
        JSON.stringify([
          { symbol: "BTCUSDT", price: "60000" },
          { symbol: "ETHUSDT", price: "3000" },
        ]),
        { status: 200 },
      );
    });
    const { balances, note } = await binanceProvider.fetchBalances(ctx());
    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(4);
    expect(balances.some((b) => b.kind !== "spot")).toBe(false);
    expect(note?.[0]?.title).toBe("Wallets not synced");
    expect(String(note?.[0]?.content)).toContain("Futures");
  });

  it("serves connectorId binance;PC 仅声明三个 base URL 覆盖 key(env 注入用,非账户凭据)", () => {
    expect(binanceProvider.id).toBe("binance");
    expect(binanceProvider.creds.map((f) => f.key)).toEqual([
      "BINANCE_API_BASE",
      "BINANCE_FAPI_BASE",
      "BINANCE_DAPI_BASE",
    ]);
    // 全 public(不加密/不导出)、不进 UI 表单(表单只认 account.creds)。
    expect(binanceProvider.creds.every((f) => f.type === "public")).toBe(true);
  });

  // #264:出口 IP 被地区封时,app 从 env 把代理 base 注入 ctx.creds。connector 只把它当不透明整串用,
  // 三个 host 各走各的覆盖 base(独立);不设即默认直连。此测反查:没有覆盖注入就会打回 *.binance.com。
  it("ctx.creds 三个 base 覆盖 → 现货/U本位/币本位/公开行情各打各自覆盖 base,默认 host 一个不留", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes("/dapi/v1/account"))
        return new Response(JSON.stringify({ assets: [], positions: [] }), { status: 200 });
      if (u.includes("/fapi/v2/account"))
        return new Response(JSON.stringify({ totalMarginBalance: "0", positions: [] }), {
          status: 200,
        });
      if (u.includes("/api/v3/account"))
        return new Response(JSON.stringify({ balances: [] }), { status: 200 });
      // funding(数组)+ earn(翻页,数组无 rows → 空)都在 /sapi/ 下,给空数组即可。
      if (u.includes("/sapi/")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 }); // /api/v3/ticker/price
    });

    await binanceProvider.fetchBalances(
      ctx(
        { apiKey: "k", secret: "s" },
        {
          BINANCE_API_BASE: "https://px.example/s/binance",
          BINANCE_FAPI_BASE: "https://px.example/s/binance-fapi",
          BINANCE_DAPI_BASE: "https://px.example/s/binance-dapi",
        },
      ),
    );

    const hit = (prefix: string) => seen.some((u) => u.startsWith(prefix));
    expect(hit("https://px.example/s/binance/api/v3/account")).toBe(true); // 现货签名
    expect(hit("https://px.example/s/binance/api/v3/ticker/price")).toBe(true); // 公开行情(同 api 覆盖)
    expect(hit("https://px.example/s/binance-fapi/fapi/v2/account")).toBe(true); // U 本位
    expect(hit("https://px.example/s/binance-dapi/dapi/v1/account")).toBe(true); // 币本位
    expect(seen.some((u) => u.includes("binance.com"))).toBe(false); // 默认 host 一个不留
  });
});

// 契约(#240):凭据被拒 → false;够不到上游 → 抛 ProviderError,让调用方重试。
// 缺 creds 的守卫不在这里测 —— validateAccount 恒在 validateCredentials(强制 apiKey/secret 非空)
// 之后调,缺字段进不到这一层。
describe("binanceProvider.validateAccount", () => {
  it("200 → true", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await binanceProvider.validateAccount(ctx())).toBe(true);
  });

  it("凭据被拒(401 → AUTH_FAILED)→ false,不抛", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await binanceProvider.validateAccount(ctx())).toBe(false);
  });

  // binance 用 HTTP 400 表达错 secret(-1022,签名对不上)/ key 格式非法(-2014)—— 凭据问题,
  // 不该重试、不该拿错凭据再打上游(#240)。归 AUTH_FAILED → false。
  it("签名被拒(400)→ false,不抛也不重试", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"code":-1022,"msg":"Signature invalid"}', { status: 400 }));
    expect(await binanceProvider.validateAccount(ctx())).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("429 → 抛 RATE_LIMITED(retryable),不压成 false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const err = await binanceProvider.validateAccount(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
  });

  it("5xx → 抛 UPSTREAM_ERROR(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const err = await binanceProvider.validateAccount(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.retryable).toBe(true);
  });
});
