import { beforeEach, describe, expect, it } from "vitest";
import { handleListTokenCatalogue } from "@/lib/server/tokens/catalogue";
import { handleListTokens, ListTokensInput } from "@/lib/server/tokens/list";
import { countRows } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// 合并进 tokens/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tokens/list", () => {
  // #527 · listTokenCatalogue / listTokens
  //
  // **这一片最该测的是「点中不建行」**:选币是读操作,划过十个候选不该在库里留十行垃圾。
  // 上游打桩成固定答案 —— 这两个端点的返回本来就与用户无关(边缘缓存的键里没有 userId)。
  const USER = "h-tok-list";

  const MARKETS = [
    { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 50_000, market_cap_rank: 1 },
    { id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3_000, market_cap_rank: 2 },
  ];
  const SEARCH = {
    coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap_rank: 1 }],
  };

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("listTokenCatalogue", () => {
    it("返回一批热门币,每个都带符号与展示名", async () => {
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);

      const out = await call(USER, handleListTokenCatalogue());

      expect(out.length).toBeGreaterThan(0);
      expect(out[0].symbol).toBeTruthy();
      expect(out[0].name).toBeTruthy();
    });

    it("给出去的是一张票,不是内部 id", async () => {
      // 点中不建行的另一半:那时候还没有代币行,所以能给的只有一张编码过的引用。
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);

      const out = await call(USER, handleListTokenCatalogue());

      expect(out[0].ticket).toBeTruthy();
      expect(out[0]).not.toHaveProperty("id");
    });

    it("点中不建行 —— 调完之后代币行数一个都没变", async () => {
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      const before = await countRows("tokens", USER);

      await call(USER, handleListTokenCatalogue());

      expect(await countRows("tokens", USER)).toBe(before);
    });

    it("上游挂了但边缘缓存里有 → 返回缓存那份,不报错", async () => {
      // **实测发现的事实,顺手变成一条用例:** 这套 harness 里 Workers Cache 是真生效的
      // (原以为 Miniflare 下它是空转 —— 那是 workers.dev 上的情形)。于是清单里
      // 「上游挂了但缓存里有 → 返回缓存那份」这条真的测得了,而不是只能靠推理。
      stubOutbound([["/coins/markets", () => json(MARKETS)]]);
      const warm = await call(USER, handleListTokenCatalogue());
      expect(warm.length).toBeGreaterThan(0);

      stubOutbound([["/coins/markets", () => json({ error: "boom" }, 500)]]);
      const out = await call(USER, handleListTokenCatalogue());

      expect(out).toEqual(warm);
    });
  });

  describe("listTokens(搜长尾)", () => {
    it("搜 btc → 结果里有 Bitcoin", async () => {
      stubOutbound([["/search", () => json(SEARCH)]]);

      const out = await call(USER, handleListTokens({ query: "btc" }));

      expect(out.map((o) => o.symbol.toLowerCase())).toContain("btc");
    });

    it("空查询 / 纯空格 → 直接返回空,一发外呼都不发", async () => {
      // `blockOutbound` 会让任何外呼抛错,所以「没抛」本身就是「没打」的证明;
      // 再断言一次 calls 为空,是为了让失败信息直接说清打了哪个 URL。
      const outbound = blockOutbound();

      expect(await call(USER, handleListTokens({ query: "" }))).toEqual([]);
      expect(await call(USER, handleListTokens({ query: "   " }))).toEqual([]);
      expect(outbound.calls).toEqual([]);
    });

    it("点中不建行 —— 搜十次也不留一行垃圾", async () => {
      stubOutbound([["/search", () => json(SEARCH)]]);
      const before = await countRows("tokens", USER);

      for (const q of [
        "b",
        "bt",
        "btc",
        "btc ",
        "bitc",
        "bitco",
        "bitcoi",
        "bitcoin",
        "btcx",
        "x",
      ]) {
        await call(USER, handleListTokens({ query: q }));
      }

      expect(await countRows("tokens", USER)).toBe(before);
    });

    it("查询里带特殊字符 → 不拼坏上游 URL(打出去的是编码过的)", async () => {
      const outbound = stubOutbound([["/search", () => json({ coins: [] })]]);

      await call(USER, handleListTokens({ query: "a&b=c?d#e" }));

      expect(outbound.calls).toHaveLength(1);
      expect(outbound.calls[0]).not.toContain("a&b=c?d#e");
      expect(outbound.calls[0]).toContain("a%26b");
    });

    it("上游挂了、缓存也没有(全新关键词)→ 明确失败,不是静默返回半份", async () => {
      // 关键词换成没搜过的那一个 —— 否则会命中上一条留下的缓存,测不到冷启动那半。
      stubOutbound([["/search", () => json({ error: "boom" }, 500)]]);

      await expect(call(USER, handleListTokens({ query: "冷启动才用的词" }))).rejects.toThrow();
    });

    it("query 缺席 → schema 拒", () => {
      expect(ListTokensInput.safeParse({}).success).toBe(false);
    });
  });
});
