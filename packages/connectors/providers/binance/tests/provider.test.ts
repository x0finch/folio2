import { ProviderError } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binanceProvider, parseAccountBalances } from "../src";
import account from "./fixtures/account.json";
import coinmAccount from "./fixtures/coinm-account.json";
import expected from "./fixtures/expected-balances.json";
import futuresAccount from "./fixtures/futures-account.json";
import prices from "./fixtures/prices.json";

// 新 FetchContext 形状:account.creds(AC:apiKey/secret,由分派桥 openCreds 解密后灌入)+ creds(PC:空)。
type Ctx = Parameters<typeof binanceProvider.fetchBalances>[0];
function ctx(creds: Record<string, string> = { apiKey: "k", secret: "s" }): Ctx {
  return {
    account: { id: "a1", label: "Binance", connectorId: "binance", creds },
    creds: {},
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
    expect(balances.filter((b) => b.kind === "spot")).toHaveLength(4);
    // U本位 + 币本位各一个权益行
    expect(balances.filter((b) => b.kind === "perp_equity")).toHaveLength(2);
    // U本位 2 持仓 + 币本位 2 持仓
    expect(balances.filter((b) => b.kind === "perp_position")).toHaveLength(4);
    expect(note).toBeUndefined();
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

  it("serves connectorId binance, no provider-level creds (账户自带密钥)", () => {
    expect(binanceProvider.id).toBe("binance");
    expect(binanceProvider.creds).toEqual([]);
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
