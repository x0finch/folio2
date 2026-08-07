import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MARKETS_PER_PAGE, RETRY_MAX_WAIT_MS } from "../src/constants";
import { makeUpstreamEffects } from "../src/upstream";
import { type Stub, run, runDriven, stubbing } from "./harness";

// 重试**搬家到了这里**:老那版收在 `@folio/coingecko-client` 的传输层里,Effect 版的 client
// 一律不自带重试(它是九个 client 的共同形状)。所以策略现在是本包的东西,得由本包钉住。
//
// 断言的是**发了几次**,不是等了多久(CODING.md:限频/时序测试别断言墙钟)。

const platforms = [{ id: "ethereum", chain_identifier: 1, name: "Ethereum" }];

// 前 n 发按给定状态失败,之后成功。
const failingFirst = (n: number, status: number): Stub =>
  stubbing((_call, nth) => (nth < n ? new Error(String(status)) : platforms));

// 429 + Retry-After(带 header 的要自己造一个 `Response`,哨兵只带状态码)。
const rateLimited = (retryAfterSec: number, failures: number): Stub =>
  stubbing((_call, nth) =>
    nth < failures
      ? new Response(null, { status: 429, headers: { "retry-after": String(retryAfterSec) } })
      : platforms,
  );

describe("哪些错误会再打一发", () => {
  it("5xx 是「够不到上游」→ 重打一次就成了", async () => {
    const stub = failingFirst(1, 503);
    await runDriven(stub, makeUpstreamEffects().fetchMarkets({ topN: 1 }));
    expect(stub.calls).toHaveLength(2);
  });

  it("重试次数封顶 —— 一直 5xx 就放弃,总共两发", async () => {
    const stub = failingFirst(99, 503);
    const err = await runDriven(
      stub,
      Effect.flip(makeUpstreamEffects().fetchMarkets({ topN: 1 })),
    );
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(stub.calls).toHaveLength(2);
  });

  it("401 是「凭据问题」→ 一发就放弃,重试没用", async () => {
    const stub = failingFirst(99, 401);
    const err = await run(stub, Effect.flip(makeUpstreamEffects().fetchMarkets({ topN: 1 })));
    expect(err._tag).toBe("UpstreamAuthError");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("Retry-After:听上游的,但有个肯等的上限", () => {
  it("上游说的等待在上限内 → 等完再打一发", async () => {
    const stub = rateLimited(1, 1); // 1 秒,在 2 秒上限内
    await runDriven(stub, makeUpstreamEffects().fetchMarkets({ topN: 1 }));
    expect(stub.calls).toHaveLength(2);
  });

  // 这是老 `withRetry` 的 `exceedsMaxWait: "throw"`,与后台同步那份的 clamp **刻意相反**:
  // 这条路可能挂在用户的写路径上,夹到 2 秒再打大概率还是 429,白赔一次往返 ——
  // 不如当场失败,让 SWR 顶旧数据。
  it("上游说的等待超过上限 → **直接放弃**,不夹到上限继续等", async () => {
    const stub = rateLimited(RETRY_MAX_WAIT_MS / 1000 + 58, 99); // 60 秒,远超上限
    const err = await runDriven(
      stub,
      Effect.flip(makeUpstreamEffects().fetchMarkets({ topN: 1 })),
    );
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("重试的粒度是一发请求,不是一个方法", () => {
  // `fetchMarkets` 翻页时第二页失败,该重打的是第二页 —— 不是从第一页重来。
  // 老那版把重试放在传输层里,天然就是这个粒度;换成显式的之后得自己保证。
  it("翻页途中失败 → 只重打失败的那一页", async () => {
    const rows = (pageNo: number) =>
      Array.from({ length: MARKETS_PER_PAGE }, (_, i) => ({
        id: `coin-${(pageNo - 1) * MARKETS_PER_PAGE + i}`,
        symbol: "c",
        name: "c",
        current_price: 1,
      }));

    let secondPageTries = 0;
    const stub = stubbing((call) => {
      const page = Number(call.query.get("page"));
      if (page === 2 && ++secondPageTries === 1) return new Error("503");
      return page >= 3 ? [] : rows(page);
    });

    await runDriven(stub, makeUpstreamEffects().fetchMarkets({ topN: MARKETS_PER_PAGE * 3 }));

    const pages = stub.calls.map((c) => c.query.get("page"));
    expect(pages.filter((p) => p === "1")).toHaveLength(1); // 第一页没有重来
    expect(pages.filter((p) => p === "2")).toHaveLength(2); // 失败的那页重打了一次
  });
});

describe("并发的两发各自重试,互不牵连", () => {
  // `fetchRefIndex` 同时拉币目录和平台表。平台表那一发失败,重打的只该是它。
  it("两个端点里只有一个失败 → 只有它重来", async () => {
    let platformTries = 0;
    const stub = stubbing((call) => {
      if (!call.path.includes("/asset_platforms")) return [];
      return ++platformTries === 1 ? new Error("503") : platforms;
    });

    await runDriven(stub, makeUpstreamEffects().fetchRefIndex());

    expect(stub.calls.filter((c) => c.path.includes("/asset_platforms"))).toHaveLength(2);
    expect(stub.calls.filter((c) => c.path.includes("/coins/list"))).toHaveLength(1);
  });
});
