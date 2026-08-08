import { DEFAULT_TOP_N, PRICE_TTL_MS, type UpstreamToken } from "@folio/oracle-basic";
import { Duration, Effect, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { CandidateSource } from "../src/tokens/candidates";
import { harness, upstreamDown } from "./fakes";

// mint 的 symbol 那一档要问的候选源(#216)。它**在写路径上** —— 同步、以及手记录入那个
// 用户正等着的表单 —— 所以它对新鲜度的容忍度跟橱窗完全不同:有就用,多旧都用。
//
// 这一组盯的就是「它到底会不会出网」。以前它是 `tokens.candidates`,背后是橱窗那条会回源的
// SWR:warm 一过期,mint 中途串行夹进 4 次目录请求,而 mint 的注释还写着「全程不碰网络」。

const coin = (id: string, symbol: string, rank?: number): UpstreamToken => ({
  ref: `src/issued:${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

function setup(markets: UpstreamToken[] = []) {
  const h = harness();
  h.upstream.markets = markets;
  return h;
}

const bySymbol = (symbol: string) => Effect.flatMap(CandidateSource, (c) => c.bySymbol(symbol));

describe("按 symbol 出候选", () => {
  it("同名的都给,带上排名(判官自己决定信不信)", async () => {
    const h = setup([coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)]);
    expect(await h.run(bySymbol("usdc"))).toEqual([
      { ref: "src/issued:usd-coin", marketCapRank: 6 },
      { ref: "src/issued:fake-usdc", marketCapRank: 4200 },
    ]);
  });

  it("归一同口径 —— 大小写与空白不影响命中", async () => {
    const h = setup([coin("bitcoin", "btc", 1)]);
    expect(await h.run(bySymbol("  BTC "))).toEqual([
      { ref: "src/issued:bitcoin", marketCapRank: 1 },
    ]);
  });

  it("没有同名的 → 空,不报错", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    expect(await h.run(bySymbol("NOPE"))).toEqual([]);
  });
});

describe("**不为新鲜度出网** —— 这是它与橱窗的唯一区别", () => {
  it("目录再旧也不回源:第一次之后,一年过去仍是零请求", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    await h.run(
      Effect.gen(function* () {
        yield* bySymbol("BTC"); // 冷 → 取一次

        for (const skip of [PRICE_TTL_MS + 1, 24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000]) {
          yield* TestClock.adjust(Duration.millis(skip));
          expect(yield* bySymbol("BTC")).toHaveLength(1);
        }
      }),
    );
    expect(h.upstream.calls).toEqual([`fetchMarkets:${DEFAULT_TOP_N}`]); // 始终只有那一次
  });

  it("一轮 mint 里问很多次 symbol → 仍然只有冷启动那一次请求", async () => {
    const h = setup([coin("bitcoin", "BTC", 1), coin("tether", "USDT", 3)]);
    await h.run(
      Effect.forEach(["BTC", "USDT", "NOPE", "BTC", "USDT"], bySymbol, { discard: true }),
    );
    expect(h.upstream.calls).toHaveLength(1);
  });
});

describe("冷启动", () => {
  it("完全没有缓存 → 取一次。躲不掉:候选为空 = 按 symbol 认的币集体认不出来", async () => {
    const h = setup([coin("bitcoin", "BTC", 1)]);
    expect(await h.run(bySymbol("BTC"))).toHaveLength(1);
    expect(h.upstream.calls).toHaveLength(1);
  });

  it("冷启动就被限流 → 空候选、不抛。认不出来总好过让整轮同步崩", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    expect(await h.run(bySymbol("BTC"))).toEqual([]);
  });

  it("上游后来好了 → 下一次自动补上(空 blob 不会被写进缓存)", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    await h.run(bySymbol("BTC"));

    h.upstream.fail = undefined;
    h.upstream.markets = [coin("bitcoin", "BTC", 1)];
    expect(await h.run(bySymbol("BTC"))).toHaveLength(1);
  });
});
