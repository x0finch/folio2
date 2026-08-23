import { env } from "cloudflare:test";
import { GlobalTokenRefIndexStore } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { globalTokenRefIndexStoreLayer } from "../src";
import { getDb } from "../src/connect";
import { globalTokenRefIndex } from "../src/schema";
import { promisified } from "./effect";

// `global_token_ref_index` 的真 D1 测试(ADR 0022,#199 / #228)。
// 这张表**没有 userId** —— 里面一条用户数据都没有,全是上游的公开知识(原则 #6 的受控例外)。
// 表里两条 ref:chain_ref(链上寻址)+ upstream ref(上游命名,拆成 upstream/upstream_local_name 两列)。

const CGK = "coingecko";
const CMC = "coinmarketcap";
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 上游整条 ref(#228:表存 / lookup 返回的都是整条,不是裸 id)。
const cgk = (id: string) => tokenRef.issued(CGK, id);
const cmc = (id: string) => tokenRef.issued(CMC, id);

beforeEach(async () => {
  await getDb(env).delete(globalTokenRefIndex);
});

// 生产那条路(layer → Tag);`promisified` 只是让用例照旧 `await s.xxx(…)`。
// 全局表不按用户隔离(ADR 0022),`CurrentUser` 对它没有意义 —— 把手仍要一个,给个占位。
const store = () => promisified(GlobalTokenRefIndexStore, globalTokenRefIndexStoreLayer, "n/a");

describe("整份灌 + 正查", () => {
  it("灌进去,按 (upstream, chainRef) 点查得回**整条** upstream ref;miss 的键不出现", async () => {
    const s = store();
    await s.putAll(
      [
        { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") },
        { chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") },
      ],
      1000,
    );
    const got = await s.lookup(CGK, [USDC_ETH, USDC_SOL, "evm:1/contract:0xdead"]);
    expect(got.get(USDC_ETH)).toBe(cgk("usd-coin"));
    expect(got.get(USDC_SOL)).toBe(cgk("usd-coin"));
    expect(got.has("evm:1/contract:0xdead")).toBe(false);
    expect(got.size).toBe(2);
  });

  // 验收(#228):upstream_local_name 存的是 tokenRef 的 localName **规范形**(issued:usd-coin),不是裸 id。
  it("落表:拆成 (upstream, upstream_local_name),后者是规范形不是裸 id", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const [row] = await getDb(env).select().from(globalTokenRefIndex);
    expect(row.chainRef).toBe(USDC_ETH);
    expect(row.upstream).toBe(CGK);
    expect(row.upstreamLocalName).toBe("issued:usd-coin"); // ← 不是裸 "usd-coin"
  });

  it("查另一个上游查不到 —— 主键带 upstream,两家各成一套", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    expect((await s.lookup(CMC, [USDC_ETH])).size).toBe(0);
  });

  // 「加源只加行、不改表」是这张表相对原 `cgk_refs(ref, coin_id)` 方案的全部意义。
  it("同一个地址可以同时有两家的叫法", async () => {
    const s = store();
    await s.putAll(
      [
        { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") },
        { chainRef: USDC_ETH, upstreamRef: cmc("3408") },
      ],
      1000,
    );
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe(cmc("3408"));
  });

  it("再灌一次是覆盖,不是重复行", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("old-id") }], 1000);
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 2000);
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
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
  // 表里 chain_ref 存的是规范形(灌表时经文法构造)。调用方给的串大小写可能不同 —— 不归一就查不到。
  it("EVM 地址大小写不影响命中,返回的键是调用方原样给的那个串", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const upper = "EVM:1/contract:0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
    const got = await s.lookup(CGK, [upper]);
    // 键必须是入参那个串 —— 调用方拿它去 .get()。
    expect(got.get(upper)).toBe(cgk("usd-coin"));
  });

  it("读不懂的串不查、不抛", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    const got = await s.lookup(CGK, ["nonsense", "a/b/c", USDC_ETH]);
    expect(got.size).toBe(1);
    expect(got.get(USDC_ETH)).toBe(cgk("usd-coin"));
  });
});

describe("分批写", () => {
  // 每行 4 个绑定参数,D1 一条语句 ~100 个上限 → 实现按 20 行一批。这里给 137 行,跨 7 批。
  it("行数远超单批上限也全部写进去", async () => {
    const s = store();
    const rows = Array.from({ length: 137 }, (_, i) => ({
      chainRef: `evm:1/contract:0x${i.toString(16).padStart(40, "0")}`,
      upstreamRef: cgk(`coin-${i}`),
    }));
    await s.putAll(rows, 1000);
    expect(await getDb(env).select().from(globalTokenRefIndex)).toHaveLength(137);
    const got = await s.lookup(
      CGK,
      rows.map((r) => r.chainRef),
    );
    expect(got.size).toBe(137);
    expect(got.get(rows[136].chainRef)).toBe(cgk("coin-136"));
  });

  // 覆盖写走的是 `ON CONFLICT ... SET x = excluded.x`。多行语句里没法逐行写死值,所以这条
  // 必须**跨过一条语句装得下的行数**(ROWS_PER_STATEMENT)才测得到真形状 ——
  // 只用一两行的话每条语句就一行,`excluded` 和写死值等价,漏了也是绿的。
  it("整份重灌:跨多条语句逐行覆盖,不留旧值也不留重复行", async () => {
    const s = store();
    const chainRef = (i: number) => `evm:1/contract:0x${i.toString(16).padStart(40, "0")}`;
    const first = Array.from({ length: 45 }, (_, i) => ({
      chainRef: chainRef(i),
      upstreamRef: cgk(`old-${i}`),
    }));
    await s.putAll(first, 1000);

    // 同样 45 条 ref,叫法全变 —— 每一行都该被自己那条新值覆盖(不是被某一行的值统一刷掉)。
    const second = first.map((r, i) => ({ ...r, upstreamRef: cgk(`new-${i}`) }));
    await s.putAll(second, 2000);

    expect(await getDb(env).select().from(globalTokenRefIndex)).toHaveLength(45); // 没重复行
    const got = await s.lookup(
      CGK,
      first.map((r) => r.chainRef),
    );
    expect(got.size).toBe(45);
    // 首、中、末各验一条:确实是逐行对应,不是整批被同一个值覆盖。
    expect([got.get(chainRef(0)), got.get(chainRef(22)), got.get(chainRef(44))]).toEqual([
      cgk("new-0"),
      cgk("new-22"),
      cgk("new-44"),
    ]);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(2000)); // updated_at 也走 excluded
  });

  // 正查也要分块(每块 ≤90 个键 + 1 个固定绑定)。
  it("一次查上百个 ref 不超参数上限", async () => {
    const s = store();
    // 用 0 填充 —— 拿别的字符填会让 1 / 0x11 / 0x111 撞成同一个串,行数悄悄变少。
    const rows = Array.from({ length: 200 }, (_, i) => ({
      chainRef: `evm:1/contract:0x${(i + 1000).toString(16).padStart(40, "0")}`,
      upstreamRef: cgk(`c-${i}`),
    }));
    await s.putAll(rows, 1000);
    expect(
      (
        await s.lookup(
          CGK,
          rows.map((r) => r.chainRef),
        )
      ).size,
    ).toBe(200);
  });
});

describe("刷新时刻", () => {
  it("从未刷过 → null;刷过 → 该上游行里最大的 updated_at", async () => {
    const s = store();
    expect(await s.refreshedAt(CGK)).toEqual(Option.none());

    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));
    // 另一家还是没刷过。
    expect(await s.refreshedAt(CMC)).toEqual(Option.none());

    await s.putAll([{ chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") }], 5000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(5000));
  });

  // 不删行:下架币的旧映射留着无害,updated_at 用来看哪些行这轮没被刷到。
  it("这轮没刷到的行留着,时刻还是旧的", async () => {
    const s = store();
    await s.putAll(
      [
        { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") },
        { chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") },
      ],
      1000,
    );
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 2000);

    const rows = await getDb(env).select().from(globalTokenRefIndex);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.chainRef === USDC_SOL)?.updatedAt).toBe(1000); // 没刷到
    expect(rows.find((r) => r.chainRef === USDC_ETH)?.updatedAt).toBe(2000);
  });
});
