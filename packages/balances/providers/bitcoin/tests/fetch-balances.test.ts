import type { FetchContext } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bitcoinProvider, entries } from "../src";

// provider 只整合:取数走 @folio/blockbook-client(Trezor Blockbook)。这里按 URL(/xpub/ vs /address/)
// 打桩 fetch,断言整合后的 Balance/BitcoinMeta。派生正确性在 @folio/bitcoin-derive 的离线向量测里。

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
// ZPUB84 native 派生(BIP84 向量):0/0、0/1
const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_bitcoin", label: "Cold" },
    creds: { identifier: ADDR },
    ...overrides,
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

describe("bitcoinProvider.fetchBalances — 地址模式", () => {
  it("已确认 → amount(BTC);未确认 → meta.pendingSats;value=0", async () => {
    mockBlockbook({ address: { address: ADDR, balance: "8000000", unconfirmedBalance: "500000" } });
    const [b] = await bitcoinProvider.fetchBalances(ctx());
    expect(b.symbol).toBe("BTC");
    expect(b.amount).toBe(0.08);
    expect(b.value).toBe(0);
    expect((b.meta as { pendingSats: number }).pendingSats).toBe(500000);
  });

  it("零余额零未确认 → 空", async () => {
    mockBlockbook({ address: { address: ADDR, balance: "0", unconfirmedBalance: "0" } });
    expect(await bitcoinProvider.fetchBalances(ctx())).toEqual([]);
  });
});

describe("bitcoinProvider.fetchBalances — xpub 模式(Blockbook 服务端派生)", () => {
  const XPUB_BODY = {
    address: ZPUB84,
    balance: "80000", // Blockbook 已汇总
    unconfirmedBalance: "0",
    txs: 3,
    tokens: [
      { name: RECV0, path: "m/84'/0'/0'/0/0", transfers: 2, balance: "50000" },
      { name: "bc1qchange0", path: "m/84'/0'/0'/1/0", transfers: 1, balance: "30000" },
    ],
  };

  it("顶层 balance → amount;分布(仅非零,含 receive/change);收款指引(lastUsed + 本地派生 next)", async () => {
    mockBlockbook({ xpub: XPUB_BODY });
    const [b] = await bitcoinProvider.fetchBalances(ctx({ creds: { identifier: ZPUB84 } }));
    expect(b.amount).toBe(0.0008); // 80000 sats(不逐地址求和,用顶层)
    const meta = b.meta as {
      addresses: { address: string; chain: string; balanceSats: number }[];
      receive: {
        lastUsed: { index: number; address: string };
        next: { index: number; address: string }[];
      };
    };
    expect(meta.addresses.map((a) => a.address).sort()).toEqual([RECV0, "bc1qchange0"].sort());
    expect(meta.addresses.find((a) => a.address === "bc1qchange0")?.chain).toBe("change");
    // lastUsed = 外部链最大已用(0/0);next 本地派生 0/1、0/2
    expect(meta.receive.lastUsed).toEqual({ index: 0, address: RECV0 });
    expect(meta.receive.next[0]).toEqual({ index: 1, address: RECV1 });
    expect(meta.receive.next).toHaveLength(2);
    expect(meta.receive.next[1].index).toBe(2);
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
    const [b] = await bitcoinProvider.fetchBalances(ctx({ creds: { identifier: ZPUB84 } }));
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
    const spy = mockBlockbook({ xpub: XPUB_BODY });
    await bitcoinProvider.fetchBalances(
      ctx({ creds: { identifier: ZPUB84, scriptType: "legacy" } }),
    );
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/xpub/");
    expect(url).toContain(ZPUB84); // 仍以 zpub 查询,未被 scriptType=legacy 改写
  });
});

describe("bitcoinProvider.fetchBalances — 错误映射", () => {
  it("429 → RATE_LIMITED;500(全端点)→ UPSTREAM_ERROR", async () => {
    mockBlockbook({ status: 429 });
    await expect(bitcoinProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    vi.restoreAllMocks();
    mockBlockbook({ status: 500 });
    await expect(bitcoinProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("entry registers accountType onchain_bitcoin", () => {
    expect(entries.map((e) => e.manifest.accountType)).toContain("onchain_bitcoin");
  });
});
