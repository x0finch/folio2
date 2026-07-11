import type { ScriptType } from "@folio/bitcoin-derive";
import { validateCredentials } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bitcoinAccountCreds, blockbookProvider } from "../src";
import addressFixture from "./fixtures/address.json";
import xpubFixture from "./fixtures/xpub.json";

// provider 只整合:取数走 @folio/blockbook-client(Trezor Blockbook)。这里按 URL(/xpub/ vs /address/)
// 打桩 fetch,断言整合后的 Utxo/UtxoMeta。派生正确性在 @folio/bitcoin-derive 的离线向量测里。
// 主 golden 走 JSON fixture(request 原始请求 / response 录制返回 / expected 预期结果三件一体,可直接肉眼核)。
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const RECV2 = "bc1qp59yckz4ae5c4efgw2s5wfyvrz0ala7rgvuz8z";
const mempool = (a: string) => `https://mempool.space/address/${a}`;

// 新 FetchContext 形状:account.creds(AC:addressOrXpub + scriptType)+ creds(PC:空)。
// CredsOf 把两字段都作必填键(scriptType 值可为 undefined),故显式带上 scriptType 键。
function ctx(input: { addressOrXpub: string; scriptType?: ScriptType } = { addressOrXpub: ADDR }) {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: {},
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// 按 URL 分流的 fetch mock。
function mockBlockbook(opts: { xpub?: unknown; address?: unknown; status?: number }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (opts.status && opts.status >= 400) return new Response("", { status: opts.status });
    return String(url).includes("/xpub/") ? json(opts.xpub) : json(opts.address);
  });
}

afterEach(() => vi.restoreAllMocks());

// per-balance detail(DetailBlock 重设计):BTC 展示明细挂在那笔 BTC balance 的 detail 上。
// golden 比对时先剥 detail(纯映射),detail 单独断言。
const stripDetail = (balances: { detail?: unknown }[]) => balances.map(({ detail, ...b }) => b);

describe("blockbookProvider.fetchBalances — 地址模式(golden fixture)", () => {
  it("录制响应 → 预期 Utxo[](已确认→amount;未确认→meta.pendingSats;value=0;kind=utxo)", async () => {
    mockBlockbook({ address: addressFixture.response });
    const out = await blockbookProvider.fetchBalances(
      ctx({ addressOrXpub: addressFixture.request.addressOrXpub }),
    );
    expect(stripDetail(out)).toEqual(addressFixture.expected);
    // BTC balance.detail:未确认 500000 sats → 一个 Unconfirmed section(仅 pending 行)。
    expect(out[0]?.detail).toEqual([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.005, unit: "BTC" }],
      },
    ]);
  });

  it("零余额零未确认 → 空(无 balance、故无 detail)", async () => {
    mockBlockbook({ address: { address: ADDR, balance: "0", unconfirmedBalance: "0" } });
    const out = await blockbookProvider.fetchBalances(ctx());
    expect(out).toEqual([]);
  });
});

describe("blockbookProvider.fetchBalances — xpub 模式(golden fixture,Blockbook 服务端派生)", () => {
  it("录制 xpub 响应 → 预期 Utxo[](分布仅非零 + receive/change;收款指引 lastUsed + 本地派生 next)", async () => {
    mockBlockbook({ xpub: xpubFixture.response });
    const out = await blockbookProvider.fetchBalances(
      ctx({ addressOrXpub: xpubFixture.request.addressOrXpub }),
    );
    expect(stripDetail(out)).toEqual(xpubFixture.expected);
    // BTC balance.detail:无未确认 → 无 Unconfirmed;Receive addresses(lastUsed + 本地派生 next)+
    // receive/change 派生分布两 section(地址行 value+unit+href)。
    expect(out[0]?.detail).toEqual([
      {
        title: "Receive addresses",
        icon: "info",
        content: [
          { label: "Last used #0", value: RECV0, href: mempool(RECV0) },
          { label: "Next #1", value: RECV1, href: mempool(RECV1) },
          { label: "Next #2", value: RECV2, href: mempool(RECV2) },
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
        content: [
          { label: "bc1qchange0", value: 0.0003, unit: "BTC", href: mempool("bc1qchange0") },
        ],
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
    const [b] = await blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84 }));
    const meta = b.meta as {
      addresses: { address: string }[];
      receive: { lastUsed: { index: number }; next: { index: number }[] };
    };
    // 分布只含非零(0/0);但 lastUsed 取到最大已用下标 0/1,next 从 0/2 起。
    expect(meta.addresses.map((a) => a.address)).toEqual([RECV0]);
    expect(meta.receive.lastUsed.index).toBe(1);
    expect(meta.receive.next[0].index).toBe(2);
  });

  it("请求打到 /xpub/ 且带 zpub token(zpub 前缀权威,scriptType 被忽略)", async () => {
    const spy = mockBlockbook({ xpub: xpubFixture.response });
    await blockbookProvider.fetchBalances(ctx({ addressOrXpub: ZPUB84, scriptType: "legacy" }));
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/xpub/");
    expect(url).toContain(ZPUB84); // 仍以 zpub 查询,未被 scriptType=legacy 改写
  });
});

describe("blockbookProvider.fetchBalances — 错误映射", () => {
  it("429 → RATE_LIMITED;500(全端点)→ UPSTREAM_ERROR", async () => {
    mockBlockbook({ status: 429 });
    await expect(blockbookProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    vi.restoreAllMocks();
    mockBlockbook({ status: 500 });
    await expect(blockbookProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("id=blockbook,creds 为空(公共实例免 key,开箱即用)", () => {
    expect(blockbookProvider.id).toBe("blockbook");
    expect(blockbookProvider.creds).toEqual([]);
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
