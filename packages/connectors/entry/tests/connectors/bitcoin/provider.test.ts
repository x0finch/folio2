import type { ScriptType } from "@folio/bitcoin-derive";
import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import {
  type ConnectorError,
  type ProviderNeeds,
  validateCredentials,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bitcoinAccountCreds, blockbookProvider } from "../../../src/connectors/bitcoin/provider";
import addressFixture from "./fixtures/address.json";
import xpubFixture from "./fixtures/xpub.json";

// 打桩打在 `HttpClient` 服务上,不再是 `globalThis.fetch` —— 那才是生产走的路。
let stub: HttpStub;
const run = <A>(effect: Effect.Effect<A, ConnectorError, ProviderNeeds>): Promise<A> =>
  runClient(stub, effect);
const failing = (
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

// provider 只整合:取数走 @folio/blockbook-client(Trezor Blockbook)。这里按 URL(/xpub/ vs /address/)
// 打桩 fetch,断言整合后的 spot 行 + account 级 Note。派生正确性在 @folio/bitcoin-derive 的离线向量测里。
// 主 golden 走 JSON fixture(request 原始请求 / response 录制返回 / expected 预期结果三件一体,可直接肉眼核)。
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
// 录制响应里外部链最大已用下标是 41(0/28–0/30 未用),change 链只用过 1/0。
const LAST_USED41 = "bc1q8jkgp7wyyc47h5fj83y3pc5r2n24u6thcdxe04";
const NEXT42 = "bc1qg6sjfylq0sdj258ghvch4quz9379ajqvqnjtux";
const NEXT43 = "bc1qa3w5eljjp5ehlmqqj2975nvmnz29q2qprlegd0";
const CHANGE0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const mempool = (a: string) => `https://mempool.space/address/${a}`;

// 新 FetchContext 形状:account.creds(AC:addressOrXpub + scriptType)+ creds(PC:空)。
// CredsOf 把两字段都作必填键(scriptType 值可为 undefined),故显式带上 scriptType 键。
// PC 默认不给(生产不设 base 覆盖);CredsOf 把它作必填键,所以这里按契约形状收一次。
type Ctx = Parameters<typeof blockbookProvider.fetchBalances>[0];
function ctx(
  input: { addressOrXpub: string; scriptType?: ScriptType } = { addressOrXpub: ADDR },
  providerCreds: Record<string, string> = {},
): Ctx {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: providerCreds,
  } as unknown as Ctx;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// 按 pathname 分流。**每个用例自己建一个桩** —— 这家 client 是四节点轮换,而轮询起点是模块级的
// (刻意:不让每轮同步都从同一个节点开始),所以断言「打了哪个 host」会跨用例漂;这里只按路径分。
function mockBlockbook(opts: { xpub?: unknown; address?: unknown; status?: number }) {
  stub = httpStub((request) => {
    if (opts.status && opts.status >= 400) return json({}, opts.status);
    return request.url.pathname.includes("/xpub/") ? json(opts.xpub) : json(opts.address);
  });
  return stub;
}

// account 级 note(note 重设计,Note[] 整钱包):BTC 展示明细已从 per-balance 提到 fetchBalances 顶层
// note(整钱包一份)。balances 本身不再带 note;golden 直接比对 out.balances,note 单独断言。

describe("blockbookProvider.fetchBalances — 地址模式(golden fixture)", () => {
  it("录制响应 → 预期 spot 行(已确认→amount;value=0;kind=spot;明细走 note)", async () => {
    mockBlockbook({ address: addressFixture.response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: addressFixture.request.addressOrXpub })),
    );
    expect(balances).toEqual(addressFixture.expected);
    // account 级 note:未确认 500000 sats → 一个 Unconfirmed section(仅 pending 行)。
    expect(note).toEqual([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.005, unit: "BTC" }],
      },
    ]);
  });

  it("零余额零未确认 → 空(无 balance、故 note 为空)", async () => {
    mockBlockbook({ address: { address: ADDR, balance: "0", unconfirmedBalance: "0" } });
    const { balances, note } = await run(blockbookProvider.fetchBalances(ctx()));
    expect(balances).toEqual([]);
    expect(note).toEqual([]);
  });
});

describe("blockbookProvider.fetchBalances — xpub 模式(golden fixture,Blockbook 服务端派生)", () => {
  // xpub.json 是真实录制的 Blockbook 响应(BIP84 公开测试向量 zpub,`details=tokenBalances&tokens=used`,
  // 2026-10 录自 btc2.trezor.io):40 个已用地址,账户与各地址余额全为 0。
  it("录制 xpub 响应(余额 0)→ 无 spot 行;收款指引 lastUsed=外部链最大已用下标 + 本地派生 next", async () => {
    mockBlockbook({ xpub: xpubFixture.response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: xpubFixture.request.addressOrXpub })),
    );
    expect(balances).toEqual(xpubFixture.expected);
    // 无未确认 → 无 Unconfirmed;各地址余额全 0 → 无 receive/change 分布段。
    expect(note).toEqual([
      {
        title: "Receive addresses",
        icon: "info",
        content: [
          { label: "Last used #41", value: LAST_USED41, href: mempool(LAST_USED41) },
          { label: "Next #42", value: NEXT42, href: mempool(NEXT42) },
          { label: "Next #43", value: NEXT43, href: mempool(NEXT43) },
        ],
      },
    ]);
  });

  it("非零余额 + 未确认 → spot 行、Unconfirmed 段、receive/change 分布(仅非零)", async () => {
    // 录制的那个钱包余额已清零,所以**拷一份真实响应、只改数字**(字段与地址原样不动)来走非零路径:
    // 账户 80000 sats 已确认 + 10000 未确认;receive 0/0 留 50000、change 1/0 留 30000。
    const response = structuredClone(xpubFixture.response);
    response.balance = "80000";
    response.unconfirmedBalance = "10000";
    for (const t of response.tokens) {
      if (t.name === RECV0) t.balance = "50000";
      if (t.name === CHANGE0) t.balance = "30000";
    }
    mockBlockbook({ xpub: response });
    const { balances, note } = await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84 })),
    );
    expect(balances).toEqual([
      { symbol: "BTC", amount: 0.0008, value: 0, kind: "spot", tokenRef: "bitcoin/native" },
    ]);
    expect(note).toEqual([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.0001, unit: "BTC" }],
      },
      {
        title: "Receive addresses",
        icon: "info",
        content: [
          { label: "Last used #41", value: LAST_USED41, href: mempool(LAST_USED41) },
          { label: "Next #42", value: NEXT42, href: mempool(NEXT42) },
          { label: "Next #43", value: NEXT43, href: mempool(NEXT43) },
        ],
      },
      {
        title: "Receive distribution",
        icon: "info",
        content: [{ label: RECV0, value: 0.0005, unit: "BTC", href: mempool(RECV0) }],
      },
      {
        title: "Change distribution",
        icon: "info",
        content: [{ label: CHANGE0, value: 0.0003, unit: "BTC", href: mempool(CHANGE0) }],
      },
    ]);
  });

  it("已用但零余额地址(如仅 mempool 收过款)算 lastUsed,但不进分布", async () => {
    // tokens=used 会返回已用地址;0/1 已用但确认余额 0(例如仅 mempool 收款后又转出/未确认)。
    mockBlockbook({
      xpub: {
        address: ZPUB84,
        balance: "50000",
        unconfirmedBalance: "0",
        tokens: [
          { name: RECV0, path: "m/84'/0'/0'/0/0", transfers: 2, balance: "50000" },
          { name: RECV1, path: "m/84'/0'/0'/0/1", transfers: 1, balance: "0" },
        ],
      },
    });
    const { note } = await run(blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84 })));
    // 展示细节现全在 account 级 note(balance 已并回 spot、无 meta):
    // 分布只含非零(0/0);lastUsed 取最大已用下标 0/1,next 从 0/2 起。
    const sections = note ?? [];
    const rowsOf = (c: (typeof sections)[number]["content"]) => (Array.isArray(c) ? c : []);
    const labels = sections.flatMap((s) => rowsOf(s.content).map((r) => r.label));
    expect(labels).toContain("Last used #1"); // lastUsed.index=1
    expect(labels).toContain("Next #2"); // next 从 index 2 起
    const dist = sections.find((s) => s.title === "Receive distribution");
    expect(rowsOf(dist?.content ?? []).map((r) => r.label)).toEqual([RECV0]); // 分布仅非零 RECV0
  });

  it("请求打到 /xpub/ 且带 zpub token(zpub 前缀权威,scriptType 被忽略)", async () => {
    const _spy = mockBlockbook({ xpub: xpubFixture.response });
    await run(
      blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84, scriptType: "legacy" })),
    );
    const url = String(stub.calls[0].request.url.href);
    expect(url).toContain("/xpub/");
    expect(url).toContain(ZPUB84); // 仍以 zpub 查询,未被 scriptType=legacy 改写
  });
});

describe("blockbookProvider.fetchBalances — 错误映射", () => {
  it("429 → RATE_LIMITED;500(全端点)→ UPSTREAM_ERROR", async () => {
    mockBlockbook({ status: 429 });
    expect(await failing(blockbookProvider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorRateLimitError",
    });
    mockBlockbook({ status: 500 });
    expect(await failing(blockbookProvider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorUnavailableError",
    });
  });

  it("节点覆盖生效:只打那一个节点,内置的公共节点一个不留", async () => {
    const overrides = { BLOCKBOOK_API_BASE: "http://127.0.0.1:3399/blockbook" };
    // PC 只有这一个节点覆盖(公共实例免 key,开箱即用)。
    // 声明的 key 正是这里注入后真生效的那一个(app 按声明从 env 注入 ctx.creds);全 public(不加密 / 不导出)。
    expect(blockbookProvider.creds.map((f) => f.key)).toEqual(Object.keys(overrides));
    expect(blockbookProvider.creds.every((f) => f.type === "public")).toBe(true);

    mockBlockbook({ status: 500 });
    await failing(blockbookProvider.fetchBalances(ctx({ addressOrXpub: ADDR }, overrides)));
    const urls = stub.calls.map((c) => c.request.url.href);
    // 500 本来会换下一个节点 —— 只配了一个,所以恰好一发,且落在覆盖的那个上。
    expect(urls).toEqual([`http://127.0.0.1:3399/blockbook/address/${ADDR}`]);
  });
});

describe("addressOrXpub 校验(account.creds 的 validator)", () => {
  const accept = (id: string, extra: Record<string, string> = {}) =>
    validateCredentials(bitcoinAccountCreds, { addressOrXpub: id, ...extra });
  const reject = (id: string) => expect(accept(id)).rejects.toThrow(/addressOrXpub/);

  it("接受地址 + xpub/ypub/zpub;scriptType 可选", async () => {
    await expect(accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).resolves.toBeDefined();
    await expect(accept("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).resolves.toBeDefined();
    await expect(accept(ZPUB84)).resolves.toBeDefined();
    await expect(accept(ADDR, { scriptType: "taproot" })).resolves.toBeDefined();
  });

  it("拒绝 EVM 0x / 乱串", async () => {
    await reject("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await reject("not-an-address");
  });
});
