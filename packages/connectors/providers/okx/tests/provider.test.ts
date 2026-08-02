import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPriceHint,
  earnResidualNote,
  okxProvider,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
} from "../src";
import balance from "./fixtures/balance.json";
import expected from "./fixtures/expected-balances.json";
import expectedFunding from "./fixtures/expected-funding-balances.json";
import expectedSavings from "./fixtures/expected-savings-balances.json";
import expectedStaking from "./fixtures/expected-staking-balances.json";
import funding from "./fixtures/funding.json";
import savings from "./fixtures/savings.json";
import staking from "./fixtures/staking.json";
import valuation from "./fixtures/valuation.json";

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

// 资金账户(funding 桶)golden:funding.json(录制的 /asset/balances 响应)+ 交易账户市价提示表
// → expected-funding-balances.json。覆盖:bal→amount、稳定币≈1(USDT)、交易账户市价复用(BTC)、
// 无价的币 value 0 交 oracle(PEPE)、每条带 note.group:"funding"。
describe("parseFunding (golden: fixture in → fixture out)", () => {
  it("maps recorded funding assets + price hint to expected-funding-balances", () => {
    const hint = buildPriceHint(balance.data[0].details);
    expect(parseFunding(funding.data, hint)).toEqual(expectedFunding);
  });

  it("每条 funding 余额带不渲染的 note.group='funding'(供抽屉归 Tab)", () => {
    const hint = buildPriceHint(balance.data[0].details);
    const rows = parseFunding(funding.data, hint);
    expect(rows.every((r) => r.note?.group === "funding")).toBe(true);
  });
});

// 赚币(earn 桶)golden:savings/staking 响应 + 市价提示表 → 期望值。覆盖:amt→amount、rate/apy→APY note、
// note.group:"earn"、价复用交易账户市价(ETH)/稳定币(USDT)。
describe("parseSavings / parseStaking (golden: fixture in → fixture out)", () => {
  const hint = buildPriceHint(balance.data[0].details);
  it("savings: amt→amount, rate→'Flexible · X% APY' note, group earn", () => {
    expect(parseSavings(savings.data, hint)).toEqual(expectedSavings);
  });
  it("staking: investData[].amt→amount, protocol+apy note, group earn", () => {
    expect(parseStaking(staking.data, hint)).toEqual(expectedStaking);
  });
});

// earn 残差(account 级 Note):拉到的 earn 子项加总 vs asset-valuation 的 earn 桶。
describe("earnResidualNote", () => {
  const hint = buildPriceHint(balance.data[0].details);
  const earnItems = [...parseSavings(savings.data, hint), ...parseStaking(staking.data, hint)];

  it("earn 桶 > 拉到的加总 → 挂'未细分 $X' Note", () => {
    // earn 桶 12000;拉到 USDT 5000 + ETH 6000 = 11000;残差 1000。
    const note = earnResidualNote(12000, earnItems, hint);
    expect(note?.title).toBe("Earn not itemized");
    expect(String(note?.content)).toContain("$1,000");
  });

  it("earn 桶 ≈ 拉到的加总(差额 ≤ 阈值)→ 不挂 Note", () => {
    expect(earnResidualNote(11000, earnItems, hint)).toBeUndefined();
  });

  it("有 earn 子项估不出价(残差不可信)→ 不挂 Note(不虚报)", () => {
    // 追加一个无提示价、非稳定币的 earn 项 → unpriced>0 → 抑制。
    const withUnpriced = [
      ...earnItems,
      { symbol: "XYZ", amount: 1, value: 0, kind: "spot", tokenRef: "okx/issued:XYZ" } as const,
    ];
    expect(earnResidualNote(99999, withUnpriced, hint)).toBeUndefined();
  });
});

describe("okxProvider.fetchBalances", () => {
  // 所有端点的路由 mock;positions 空(无持仓)、不匹配的返回交易账户 balance。
  const routeAll = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/api/v5/asset/balances")) return ok(funding);
      if (u.includes("/finance/savings/balance")) return ok(savings);
      if (u.includes("/finance/staking-defi/orders-active")) return ok(staking);
      if (u.includes("/asset/asset-valuation")) return ok(valuation);
      if (u.includes("/api/v5/account/positions")) return ok({ code: "0", data: [] });
      return ok(balance); // /api/v5/account/balance
    });

  it("并发全桶(交易/资金/赚币)→ 合并 spot;earn 残差挂 account 级 Note", async () => {
    routeAll();
    const { balances, note } = await okxProvider.fetchBalances(ctx());
    // 交易 4 + 资金 3 + 赚币 2(USDT 活期 + ETH staking)= 9
    expect(balances).toHaveLength(9);
    expect(balances.filter((b) => b.note?.group === "earn")).toHaveLength(2);
    // earn 桶 12000 − 拉到 11000 = 1000 → 未细分 Note
    expect(note?.[0]?.title).toBe("Earn not itemized");
    expect(String(note?.[0]?.content)).toContain("$1,000");
  });

  it("asset-valuation 失败 → 不阻断同步,只是本轮没残差 Note", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/asset/asset-valuation")) return new Response("", { status: 500 });
      if (u.includes("/api/v5/asset/balances")) return ok(funding);
      if (u.includes("/finance/savings/balance")) return ok(savings);
      if (u.includes("/finance/staking-defi/orders-active")) return ok(staking);
      if (u.includes("/api/v5/account/positions")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { balances, note } = await okxProvider.fetchBalances(ctx());
    expect(balances).toHaveLength(9); // 余额照常
    expect(note).toBeUndefined(); // 锚挂了 → 无残差 Note,但同步整体成功
  });

  // —— 片 4:尽力而为 + 四桶对账 + perp 兜底 ——
  it("部分桶失败(赚币超时)→ 其余照返回 + 账户级失败 Note;整次同步成功", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/finance/savings/balance")) return new Response("", { status: 504 });
      if (u.includes("/finance/staking-defi/orders-active"))
        return new Response("", { status: 504 });
      if (u.includes("/api/v5/asset/balances")) return ok(funding);
      // 锚说 earn 桶有 $12k,但赚币两桶都超时没拉到 → **不能**报"未细分",那是没拉到不是没细分。
      if (u.includes("/asset/asset-valuation"))
        return ok({ code: "0", data: [{ details: { earn: "12000" } }] });
      if (u.includes("/api/v5/account/positions")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { balances, note } = await okxProvider.fetchBalances(ctx());
    // 交易 4 + 资金 3 成功;赚币两桶失败 → 无 earn 行,但不抛。
    expect(balances).toHaveLength(7);
    expect(balances.some((b) => b.note?.group === "earn")).toBe(false);
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Savings");
    expect(String(failNote?.content)).toContain("Staking");
    expect(String(failNote?.content)).toContain("next time"); // 瞬时故障 → "下次补上"文案
    // earn 桶失败时**不叠**一条自相矛盾的"未细分 $12k"(那笔钱是没拉到,已由失败 Note 报了)。
    expect(note?.some((n) => n.title === "Earn not itemized")).toBe(false);
  });

  it("auth 类失败(50xxx 权限不足)→ 失败 Note 提示查权限", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      // 资金账户返回权限类错误码(HTTP 200 + 50xxx)。
      if (u.includes("/api/v5/asset/balances")) return ok({ code: "50111", msg: "Invalid Key" });
      if (u.includes("/finance/")) return ok({ code: "0", data: [] });
      if (u.includes("/asset/asset-valuation")) return ok({ code: "0", data: [] });
      if (u.includes("/api/v5/account/positions")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { note } = await okxProvider.fetchBalances(ctx());
    const failNote = note?.find((n) => n.title === "Buckets not synced");
    expect(String(failNote?.content)).toContain("Funding");
    expect(String(failNote?.content)).toContain("permissions");
  });

  it("四个余额桶全失败(429 限流所有端点)→ 抛,不拿空快照覆盖", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("positions 非空 → 挂'合约浮盈暂未纳入'perp 兜底 Note", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/api/v5/account/positions"))
        return ok({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "1", upl: "123" }] });
      if (u.includes("/api/v5/asset/balances")) return ok({ code: "0", data: [] });
      if (u.includes("/finance/")) return ok({ code: "0", data: [] });
      if (u.includes("/asset/asset-valuation")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { note } = await okxProvider.fetchBalances(ctx());
    expect(note?.some((n) => n.title === "Futures positions detected")).toBe(true);
  });

  it("positions 全是已平仓行(pos=0)→ 不虚报 perp Note", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      // OKX 可能回 pos=0 的已平仓行 —— 不是真持仓,不该触发兜底 Note。
      if (u.includes("/api/v5/account/positions"))
        return ok({ code: "0", data: [{ instId: "BTC-USDT-SWAP", pos: "0", upl: "0" }] });
      if (u.includes("/api/v5/asset/balances")) return ok({ code: "0", data: [] });
      if (u.includes("/finance/")) return ok({ code: "0", data: [] });
      if (u.includes("/asset/asset-valuation")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { note } = await okxProvider.fetchBalances(ctx());
    expect(note?.some((n) => n.title === "Futures positions detected")).toBeFalsy();
  });

  it("四桶对账:classic 桶 >0(Folio 不拉)→ 挂'经典账户未同步'残差 Note", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/asset/asset-valuation"))
        return ok({ code: "0", data: [{ details: { classic: "8888", earn: "0" } }] });
      if (u.includes("/api/v5/asset/balances")) return ok({ code: "0", data: [] });
      if (u.includes("/finance/")) return ok({ code: "0", data: [] });
      if (u.includes("/api/v5/account/positions")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    const { note } = await okxProvider.fetchBalances(ctx());
    const classic = note?.find((n) => n.title === "Classic account not synced");
    expect(String(classic?.content)).toContain("$8,888");
  });

  it("asset-valuation 必须带 ccy=USD(该端点默认 BTC 计价,不传就单位错位、对账失效)", async () => {
    const spy = routeAll();
    await okxProvider.fetchBalances(ctx());
    const valUrl = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("asset-valuation"));
    expect(valUrl).toContain("ccy=USD");
  });

  it("signs with 4 OK-ACCESS headers (base64 SIGN) and parses balances", async () => {
    // 本测聚焦交易账户签名/解析;funding 端点返回空,合并与并发另见专测。
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/api/v5/asset/balances")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
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

  it("并发打交易账户 + 资金账户,两端点均被签名调用,合并出一份余额", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/api/v5/asset/balances")) return ok(funding);
      return ok(balance); // /api/v5/account/balance
    });
    const { balances } = await okxProvider.fetchBalances(ctx());
    // 交易账户 4(BTC/USDT/ETH/OKSOL)+ 资金账户 3(USDT/BTC/PEPE)= 7,不同桶同名币各自成行(聚合层按 token_id 合并)。
    expect(balances.map((b) => b.symbol)).toEqual([
      "BTC",
      "USDT",
      "ETH",
      "OKSOL",
      "USDT",
      "BTC",
      "PEPE",
    ]);
    expect(balances.filter((b) => b.note?.group === "funding")).toHaveLength(3);

    // 两端点都被打,且都带完整签名头(同一把 key)。
    const paths = spy.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.includes("/api/v5/account/balance"))).toBe(true);
    expect(paths.some((p) => p.includes("/api/v5/asset/balances"))).toBe(true);
    for (const [, init] of spy.mock.calls) {
      const h = init?.headers as Record<string, string>;
      expect(h["OK-ACCESS-KEY"]).toBe("k");
      expect(h["OK-ACCESS-SIGN"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(h["OK-ACCESS-PASSPHRASE"]).toBe("p");
    }
  });

  // fetchBalances 现并发打多个端点(每次 fetch 需**独立** Response —— body 只能读一次,共享同一个
  // Response 对象会「Body already read」),故错误 mock 用 mockImplementation 每调用返回新 Response。
  it("maps HTTP-200 + auth code → AUTH_FAILED (OKX error model)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ok({ code: "50113", msg: "Invalid Sign" }),
    );
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps HTTP-200 + non-auth code → UPSTREAM_ERROR; 429 → RATE_LIMITED", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ok({ code: "51000", msg: "param error" }),
    );
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
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
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/api/v5/asset/balances")) return ok({ code: "0", data: [] });
      return ok(balance);
    });
    await okxProvider.fetchBalances(ctx(CREDS, { OKX_API_BASE: "https://px.example/s/okx" }));
    const urls = spy.mock.calls.map((c) => String(c[0]));
    // 交易账户 + 资金账户两端点都打覆盖 base,默认 host 一个不留。
    expect(urls.some((u) => u.startsWith("https://px.example/s/okx/api/v5/account/balance"))).toBe(
      true,
    );
    expect(urls.some((u) => u.startsWith("https://px.example/s/okx/api/v5/asset/balances"))).toBe(
      true,
    );
    expect(urls.some((u) => u.includes("www.okx.com"))).toBe(false);
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
