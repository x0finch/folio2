import { env } from "cloudflare:test";
import { tokenRef } from "@folio/oracle-ref";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { diffRefIndexPage, type RefIndexRow, refKey } from "../src/domains/global-ref-index";
import { globalTokenRefIndex } from "../src/schema";
import { forGlobal } from "./effect";

// `global_token_ref_index` 的真 D1 测试(ADR 0022,#199 / #228 / #FOL-68)。
// 这张表**没有 userId** —— 里面一条用户数据都没有,全是上游的公开知识(原则 #6 的受控例外)。
// 表里两条 ref:chain_ref(链上寻址)+ upstream ref(上游命名,拆成 upstream/upstream_local_name 两列)。
//
// #FOL-68 起 `putAll` 是**差量写**:与上游全集比对,只落真变了的行(改名/新增/下架),稳态写入 ≈ 0。
// 下面「差量写」一节钉住这个行为,其余仍验读路径(lookup / 归一)不受影响。

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

// 生产那条路(`GlobalDatabase` → 这个字段);把手只是让用例照旧 `await s.xxx(…)`。
// 全局表不按用户隔离(ADR 0022),所以这条路上**根本没有** `CurrentUser` 可给。
const store = forGlobal((db) => db.refIndex);

const rowCount = async () => (await getDb(env).select().from(globalTokenRefIndex)).length;

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

  it("同一个地址可以同时有两家的叫法,刷一家不动另一家", async () => {
    const s = store();
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    // 刷 CMC(差量按 upstream 作用域):CGK 那行一条都不该被扫到、更不该被删。
    const counts = await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cmc("3408") }], 1000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 0 });
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe(cmc("3408"));
  });

  it("空输入不查库、空行不写", async () => {
    const s = store();
    expect((await s.lookup(CGK, [])).size).toBe(0);
    expect(await s.putAll([], 1000)).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    expect(await rowCount()).toBe(0);
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

describe("差量写(#FOL-68)", () => {
  const ethRow = { chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") };
  const solRow = { chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") };

  it("库已是上游全集 → 再刷一次 0 写(省额度的核心)", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    const counts = await s.putAll([ethRow, solRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    // 一字没写 → updated_at 也不动,还是首刷那轮的 1000。
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));
  });

  it("改了叫法 → 只 update 那一行", async () => {
    const s = store();
    await s.putAll([ethRow], 1000);
    const counts = await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin-v2") }], 2000);
    expect(counts).toEqual({ updated: 1, inserted: 0, deleted: 0 });
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin-v2"));
    expect(await rowCount()).toBe(1);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(2000));
  });

  it("上游新增 → insert 新行,旧行不动", async () => {
    const s = store();
    await s.putAll([ethRow], 1000);
    const counts = await s.putAll([ethRow, solRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 0 });
    expect(await rowCount()).toBe(2);
  });

  it("上游下架 → delete 那一行(ADR 0022 改为差量删)", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    // 这轮上游只剩 ETH,SOL 已下架。
    const counts = await s.putAll([ethRow], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 1 });
    expect(await rowCount()).toBe(1);
    expect((await s.lookup(CGK, [USDC_SOL])).size).toBe(0);
    expect((await s.lookup(CGK, [USDC_ETH])).get(USDC_ETH)).toBe(cgk("usd-coin"));
  });

  it("改+增+删 一轮里同时发生,计数各就各位", async () => {
    const s = store();
    const A = "evm:1/contract:0x000000000000000000000000000000000000000a";
    const B = "evm:1/contract:0x000000000000000000000000000000000000000b";
    const C = "evm:1/contract:0x000000000000000000000000000000000000000c";
    await s.putAll(
      [
        { chainRef: A, upstreamRef: cgk("a") },
        { chainRef: B, upstreamRef: cgk("b") },
      ],
      1000,
    );
    // A 改名、B 下架、C 新增。
    const counts = await s.putAll(
      [
        { chainRef: A, upstreamRef: cgk("a2") },
        { chainRef: C, upstreamRef: cgk("c") },
      ],
      2000,
    );
    expect(counts).toEqual({ updated: 1, inserted: 1, deleted: 1 });
    expect((await s.lookup(CGK, [A])).get(A)).toBe(cgk("a2"));
    expect((await s.lookup(CGK, [B])).size).toBe(0);
    expect((await s.lookup(CGK, [C])).get(C)).toBe(cgk("c"));
  });

  it("**空上游全集绝不清表**:可疑的空响应当 no-op,库原样保留", async () => {
    const s = store();
    await s.putAll([ethRow, solRow], 1000);
    const counts = await s.putAll([], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 0, deleted: 0 });
    expect(await rowCount()).toBe(2); // 没被清
  });

  it("删除按 upstream 作用域:刷 CGK 不碰 CMC 的行", async () => {
    const s = store();
    await s.putAll([ethRow], 1000); // CGK
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cmc("3408") }], 1000); // CMC 另立一套
    // 再刷 CGK,且这轮 CGK 全下架(空的 CGK 全集但非空 payload)—— 只应删 CGK 那条,CMC 保留。
    const counts = await s.putAll([{ chainRef: USDC_SOL, upstreamRef: cgk("usd-coin") }], 2000);
    expect(counts).toEqual({ updated: 0, inserted: 1, deleted: 1 }); // 删 ETH@CGK、增 SOL@CGK
    expect((await s.lookup(CMC, [USDC_ETH])).get(USDC_ETH)).toBe(cmc("3408")); // CMC 没被动
    expect((await s.lookup(CGK, [USDC_ETH])).size).toBe(0); // CGK 的 ETH 下架了
  });

  it("跨 keyset 分页(>5000 行):游标不漏行,末页的改动照样落库", async () => {
    const s = store();
    const N = 5001; // > PAGE_ROWS(5000),强制两页
    const chainRef = (i: number) => `evm:1/contract:0x${i.toString(16).padStart(40, "0")}`;
    const first = Array.from({ length: N }, (_, i) => ({
      chainRef: chainRef(i),
      upstreamRef: cgk(`c-${i}`),
    }));
    const ins = await s.putAll(first, 1000);
    expect(ins).toEqual({ updated: 0, inserted: N, deleted: 0 });
    expect(await rowCount()).toBe(N);

    // 改末行(排序后大概率落在第 2 页)、删首行,其余原样。
    const last = first.length - 1;
    const second = first
      .filter((_, i) => i !== 0)
      .map((r, i) => (i === last - 1 ? { ...r, upstreamRef: cgk("changed") } : r));
    const counts = await s.putAll(second, 2000);
    expect(counts).toEqual({ updated: 1, inserted: 0, deleted: 1 });
    expect(await rowCount()).toBe(N - 1);
    expect((await s.lookup(CGK, [chainRef(0)])).size).toBe(0); // 首行删了
    expect((await s.lookup(CGK, [chainRef(last)])).get(chainRef(last))).toBe(cgk("changed"));
  });
});

describe("刷新时刻", () => {
  it("从未刷过 → null;刷过 → 该上游行里最大的 updated_at(只随真变动推进)", async () => {
    const s = store();
    expect(await s.refreshedAt(CGK)).toEqual(Option.none());

    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 1000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));
    expect(await s.refreshedAt(CMC)).toEqual(Option.none()); // 另一家还没刷过

    // 同一份全集再刷:0 写 → 时刻不动(#FOL-68 语义:漂成「上次有变更的时间」)。
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin") }], 5000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(1000));

    // 有真变动才推进。
    await s.putAll([{ chainRef: USDC_ETH, upstreamRef: cgk("usd-coin-v2") }], 9000);
    expect(await s.refreshedAt(CGK)).toEqual(Option.some(9000));
  });
});

// —— 差量核心的纯函数单测(零 I/O,四类边界)——
describe("diffRefIndexPage(纯函数)", () => {
  const row = (chainRef: string, name: string): RefIndexRow => ({
    chainRef,
    upstream: CGK,
    upstreamLocalName: name,
  });
  const expectedOf = (rows: RefIndexRow[]) =>
    new Map(rows.map((r) => [refKey(r.chainRef, r.upstream), r]));

  it("完全相同 → 空输出,且期望全被消费(剩下的才是新增)", () => {
    const expected = expectedOf([row("a", "issued:a"), row("b", "issued:b")]);
    const page = [row("a", "issued:a"), row("b", "issued:b")];
    expect(diffRefIndexPage(expected, page)).toEqual({ updates: [], deletes: [] });
    expect(expected.size).toBe(0); // 全命中 → 无新增
  });

  it("叫法变了 → 1 update(收的是期望那条)", () => {
    const expected = expectedOf([row("a", "issued:a-new")]);
    const page = [row("a", "issued:a-old")];
    const diff = diffRefIndexPage(expected, page);
    expect(diff.deletes).toEqual([]);
    expect(diff.updates).toEqual([row("a", "issued:a-new")]);
    expect(expected.size).toBe(0);
  });

  it("库有、期望无 → 1 delete", () => {
    const expected = expectedOf([]);
    const page = [row("a", "issued:a")];
    expect(diffRefIndexPage(expected, page)).toEqual({
      updates: [],
      deletes: [{ chainRef: "a", upstream: CGK }],
    });
  });

  it("期望有、库无 → 不在这页产出,留在 expected 里(调用方扫完后 insert)", () => {
    const expected = expectedOf([row("a", "issued:a"), row("b", "issued:b")]);
    const page = [row("a", "issued:a")]; // 只有 a 在库里
    const diff = diffRefIndexPage(expected, page);
    expect(diff).toEqual({ updates: [], deletes: [] });
    expect([...expected.values()]).toEqual([row("b", "issued:b")]); // b 是新增
  });
});
