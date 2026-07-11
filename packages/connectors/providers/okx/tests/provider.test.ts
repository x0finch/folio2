import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFrozenDetail, okxProvider, parseBalances } from "../src";
import balance from "./fixtures/balance.json";
import expected from "./fixtures/expected-balances.json";

// 新 FetchContext 形状:account.creds(AC:apiKey/secret/passphrase,由分派桥 openCreds 解密后灌入)+ creds(PC:空)。
type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const CREDS = { apiKey: "k", secret: "s", passphrase: "p" };
function ctx(creds: Record<string, string> = CREDS): Ctx {
  return {
    account: { id: "a1", label: "OKX", connectorId: "okx", creds },
    creds: {},
  } as unknown as Ctx;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

// 两份 fixture 一一对应:balance.json(录制的 /api/v5/account/balance 响应)→
// expected-balances.json(解析后的期望值)。覆盖:eq→amount、eqUsd→value(OKX 自带估值)、
// 跳过零/空(DUST)。JSON 无 undefined → expected 省略未定义字段(toEqual 视缺键==undefined)。
describe("parseBalances (golden: fixture in → fixture out)", () => {
  it("maps the recorded balance details to expected-balances", () => {
    expect(parseBalances(balance.data[0].details)).toEqual(expected);
  });
});

describe("buildFrozenDetail (golden: details → 一个 Frozen section)", () => {
  it("聚齐 frozenBal>0 的币(ETH),数量口径 + 单位符号;无冻结不计", () => {
    expect(buildFrozenDetail(balance.data[0].details)).toEqual([
      { title: "Frozen", icon: "warning", content: [{ label: "ETH", value: 0.5, unit: "ETH" }] },
    ]);
  });

  it("全无冻结 → 空数组(不吐 section)", () => {
    expect(buildFrozenDetail([{ ccy: "BTC", eq: "1", eqUsd: "1", frozenBal: "0" }])).toEqual([]);
  });
});

describe("okxProvider.fetchBalances", () => {
  it("signs with 4 OK-ACCESS headers (base64 SIGN) and parses balances", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(balance));
    const { balances, detail } = await okxProvider.fetchBalances(ctx());
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "USDT", "ETH"]);
    // 账户级 detail:ETH 有 frozenBal=0.5 → 一个 Frozen section。
    expect(detail).toEqual([
      { title: "Frozen", icon: "warning", content: [{ label: "ETH", value: 0.5, unit: "ETH" }] },
    ]);

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

  it("serves connectorId okx, no provider-level creds (账户自带密钥)", () => {
    expect(okxProvider.id).toBe("okx");
    expect(okxProvider.creds).toEqual([]);
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
