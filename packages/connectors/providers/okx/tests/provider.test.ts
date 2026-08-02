import { afterEach, describe, expect, it, vi } from "vitest";
import { okxProvider, parseBalances } from "../src";
import balance from "./fixtures/balance.json";
import expected from "./fixtures/expected-balances.json";

// 新 FetchContext 形状:account.creds(AC:apiKey/secret/passphrase,由分派桥 openCreds 解密后灌入)+ creds(PC:空)。
type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s", passphrase: "p" };
function ctx(
  creds: Record<string, string> = CREDS,
  providerCreds: Record<string, string> = {},
): Ctx {
  return {
    account: { id: "a1", label: "OKX", connectorId: "okx", creds },
    creds: providerCreds,
  } as unknown as Ctx;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

// 两份 fixture 一一对应:balance.json(录制的 /api/v5/account/balance 响应)→
// expected-balances.json(解析后的期望值)。覆盖:cashBal→amount(修 #259,不含 uPnL)、
// price=eqUsd/eq(市价)、value=amount×price、跳过零/空(DUST)。
// JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseBalances (golden: fixture in → fixture out)", () => {
  it("maps the recorded balance details to expected-balances", () => {
    // per-balance note(note 重设计,单个 Note):ETH frozenBal=0.5 → 它自己那笔挂 Frozen note;其余无 note。
    expect(parseBalances(balance.data[0].details)).toEqual(expected);
  });

  it("持有量取 cashBal 而非 eq —— 合约浮盈(uPnL)不混进现货(修 #259)", () => {
    // USDT 作合约保证金:eq=1200(含 200 浮盈),cashBal=1000(真实现金)。取 cashBal → amount=1000;
    // 价格走 eqUsd/eq=1(与 uPnL 无关),value=1000。若误用 eq,USDT 会虚增成 1200。
    const usdt = parseBalances(balance.data[0].details).find((b) => b.symbol === "USDT");
    expect(usdt).toMatchObject({ amount: 1000, price: 1, value: 1000 });
  });

  it("质押凭证币(OKSOL)只从交易账户算一次,不被质押端点重复计(不双算)", () => {
    // OKSOL 作为币已躺在交易账户 details 里(cashBal=10)。本片不打质押端点 → 它只出现一次。
    const rows = parseBalances(balance.data[0].details);
    expect(rows.filter((b) => b.symbol === "OKSOL")).toHaveLength(1);
    expect(rows.find((b) => b.symbol === "OKSOL")).toMatchObject({ amount: 10, value: 700 });
  });

  it("冻结的币(ETH)自带 Frozen note;无冻结的币(BTC/USDT)无 note", () => {
    const rows = parseBalances(balance.data[0].details);
    expect(rows.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Frozen",
      icon: "warning",
      content: "0.5 ETH · 25%",
    });
    expect(rows.find((b) => b.symbol === "BTC")?.note).toBeUndefined();
    expect(rows.find((b) => b.symbol === "USDT")?.note).toBeUndefined();
  });
});

describe("okxProvider.fetchBalances", () => {
  it("signs with 4 OK-ACCESS headers (base64 SIGN) and parses balances", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    const { balances } = await okxProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "USDT", "ETH", "OKSOL"]);
    // per-balance note:ETH 有 frozenBal=0.5 → 它自己那笔挂 Frozen note。
    expect(balances.find((b) => b.symbol === "ETH")?.note).toEqual({
      title: "Frozen",
      icon: "warning",
      content: "0.5 ETH · 25%",
    });

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/v5/account/balance");
    const h = init?.headers as Record<string, string>;
    expect(h["OK-ACCESS-KEY"]).toBe("k");
    expect(h["OK-ACCESS-PASSPHRASE"]).toBe("p");
    expect(h["OK-ACCESS-TIMESTAMP"]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO8601
    expect(h["OK-ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
  });

  // 缺 key/secret/passphrase 的拒绝已上移到分派桥的 validateCredentials(见 @folio/connectors-basic
  // creds.test);provider 信任已校验的 account.creds,故此处不再测"无请求即拒"。

  it("maps HTTP-200 + auth code → AUTH_FAILED (OKX error model)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "50113", msg: "Invalid Sign" }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps HTTP-200 + non-auth code → UPSTREAM_ERROR; 429 → RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "51000", msg: "param error" }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("serves connectorId okx;PC 仅声明 OKX_API_BASE 覆盖 key(env 注入用,非账户凭据)", () => {
    expect(okxProvider.id).toBe("okx");
    expect(okxProvider.creds.map((f) => f.key)).toEqual(["OKX_API_BASE"]);
    expect(okxProvider.creds[0]?.type).toBe("public");
  });

  // #264:出口 IP 被地区封时,app 从 env 把代理 base 注入 ctx.creds.OKX_API_BASE。connector 只当不透明整串用。
  // 反查:没有覆盖注入就会打回 www.okx.com。
  it("ctx.creds 设 OKX_API_BASE → 签名请求打覆盖 base,不打默认 www.okx.com", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    await okxProvider.fetchBalances(ctx(CREDS, { OKX_API_BASE: "https://px.example/s/okx" }));
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("https://px.example/s/okx/api/v5/account/balance");
    expect(url).not.toContain("www.okx.com");
  });
});

describe("okxProvider.validateAccount", () => {
  it("true on code 0; false on auth code (creds pre-validated upstream)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    expect(await okxProvider.validateAccount(ctx())).toBe(true);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ code: "50111", msg: "Invalid Key" }));
    expect(await okxProvider.validateAccount(ctx())).toBe(false);
  });
});
