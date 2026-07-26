import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createGlobalTokenRefIndexStore } from "../src";
import { getDb } from "../src/client";
import { globalTokenRefIndex } from "../src/schema";

// `global_token_ref_index` 的真 D1 测试(ADR 0022,#199)。
// 这张表**没有 userId** —— 里面一条用户数据都没有,全是上游的公开知识(原则 #6 的受控例外)。

const CGK = "coingecko";
const CMC = "coinmarketcap";
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

beforeEach(async () => {
  await getDb(env).delete(globalTokenRefIndex);
});

const store = () => createGlobalTokenRefIndexStore(env);

describe("整份灌 + 正查", () => {
  it("灌进去,按 (命名者, ref) 点查得回;miss 的键不出现", async () => {
    const s = store();
    await s.putAll(
      [
        { ref: USDC_ETH, namer: CGK, localName: "usd-coin" },
        { ref: USDC_SOL, namer: CGK, localName: "usd-coin" },
      ],
      1000,
    );
    const got = await s.lookup(CGK, [USDC_ETH, USDC_SOL, "evm:1/contract:0xdead"]);
    expect(got.get(USDC_ETH)).toBe("usd-coin");
    expect(got.get(USDC_SOL)).toBe("usd-coin");
    expect(got.has("evm:1/contract:0xdead")).toBe(false);
    expect(got.size).toBe(2);
  });

  it("查另一个命名者查不到 —— 主键带 namer,两家各成一套", async () => {
    const s = store();
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 1000);
    expect((await s.lookup(CMC, [USDC_ETH])).size).toBe(0);
  });

  // 「加源只加行、不改表」是这张表相对原 `cgk_refs(ref, coin_id)` 方案的全部意义。
  it("同一个地址可以同时有两家的叫法", async () => {
    const s = store();
    await s.putAll(
      [
        { ref: USDC_ETH, namer: CGK, localName: "usd-coin" },
        { ref: USDC_ETH, namer: CMC, localName: "3408" },
      ],
      1000,
    );
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe("usd-coin");
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe("3408");
  });

  it("再灌一次是覆盖,不是重复行", async () => {
    const s = store();
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "old-id" }], 1000);
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 2000);
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe("usd-coin");
    expect(await getDb(env).select().from(globalTokenRefIndex)).toHaveLength(1);
  });

  it("空输入不查库、空行不写", async () => {
    const s = store();
    expect((await s.lookup(CGK, [])).size).toBe(0);
    await s.putAll([], 1000);
    expect(await getDb(env).select().from(globalTokenRefIndex)).toHaveLength(0);
  });
});

describe("查之前先归一", () => {
  // 表里存的是规范形(灌表时经文法构造)。调用方给的串大小写可能不同 —— 不归一就查不到。
  it("EVM 地址大小写不影响命中,返回的键是调用方原样给的那个串", async () => {
    const s = store();
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 1000);
    const upper = "EVM:1/contract:0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const got = await s.lookup(CGK, [upper]);
    // 键必须是入参那个串 —— 调用方拿它去 .get()。
    expect(got.get(upper)).toBe("usd-coin");
  });

  it("读不懂的串不查、不抛", async () => {
    const s = store();
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 1000);
    const got = await s.lookup(CGK, ["nonsense", "a/b/c", USDC_ETH]);
    expect(got.size).toBe(1);
    expect(got.get(USDC_ETH)).toBe("usd-coin");
  });
});

describe("分批写", () => {
  // 每行 4 个绑定参数,D1 一条语句 ~100 个上限 → 实现按 20 行一批。这里给 137 行,跨 7 批。
  it("行数远超单批上限也全部写进去", async () => {
    const s = store();
    const rows = Array.from({ length: 137 }, (_, i) => ({
      ref: `evm:1/contract:0x${i.toString(16).padStart(40, "0")}`,
      namer: CGK,
      localName: `coin-${i}`,
    }));
    await s.putAll(rows, 1000);
    expect(await getDb(env).select().from(globalTokenRefIndex)).toHaveLength(137);
    const got = await s.lookup(
      CGK,
      rows.map((r) => r.ref),
    );
    expect(got.size).toBe(137);
    expect(got.get(rows[136].ref)).toBe("coin-136");
  });

  // 正查也要分块(每块 ≤90 个键 + 1 个固定绑定)。
  it("一次查上百个 ref 不超参数上限", async () => {
    const s = store();
    // 用 0 填充 —— 拿别的字符填会让 1 / 0x11 / 0x111 撞成同一个串,行数悄悄变少。
    const rows = Array.from({ length: 200 }, (_, i) => ({
      ref: `evm:1/contract:0x${(i + 1000).toString(16).padStart(40, "0")}`,
      namer: CGK,
      localName: `c-${i}`,
    }));
    await s.putAll(rows, 1000);
    expect(
      (
        await s.lookup(
          CGK,
          rows.map((r) => r.ref),
        )
      ).size,
    ).toBe(200);
  });
});

describe("刷新时刻", () => {
  it("从未刷过 → null;刷过 → 该命名者行里最大的 updated_at", async () => {
    const s = store();
    expect(await s.refreshedAt(CGK)).toBeNull();

    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 1000);
    expect(await s.refreshedAt(CGK)).toBe(1000);
    // 另一家还是没刷过。
    expect(await s.refreshedAt(CMC)).toBeNull();

    await s.putAll([{ ref: USDC_SOL, namer: CGK, localName: "usd-coin" }], 5000);
    expect(await s.refreshedAt(CGK)).toBe(5000);
  });

  // 不删行:下架币的旧映射留着无害,updated_at 用来看哪些行这轮没被刷到。
  it("这轮没刷到的行留着,时刻还是旧的", async () => {
    const s = store();
    await s.putAll(
      [
        { ref: USDC_ETH, namer: CGK, localName: "usd-coin" },
        { ref: USDC_SOL, namer: CGK, localName: "usd-coin" },
      ],
      1000,
    );
    await s.putAll([{ ref: USDC_ETH, namer: CGK, localName: "usd-coin" }], 2000);

    const rows = await getDb(env).select().from(globalTokenRefIndex);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ref === USDC_SOL)?.updatedAt).toBe(1000); // 没刷到
    expect(rows.find((r) => r.ref === USDC_ETH)?.updatedAt).toBe(2000);
  });
});
