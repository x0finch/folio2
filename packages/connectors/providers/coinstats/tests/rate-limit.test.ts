import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinstatsProvider } from "../src";
import { COINSTATS_API_KEY } from "../src/constants";
import solanaFixture from "./fixtures/solana.json";

// **一把 key 服务三个 connector**(sui / cosmos / solana),所以它们必须共享同一个队 ——
// 花的是同一份额度。这是本文件要钉的东西:换成每个 provider 一个队,三条链一起同步时
// 就是三倍超速,而免费档只有 2 请求/秒。

type Ctx = Parameters<ReturnType<typeof createCoinstatsProvider>["fetchBalances"]>[0];
const ctx = (): Ctx =>
  ({
    account: { id: "a1", label: "W", connectorId: "solana", creds: { address: "abc" } },
    creds: { [COINSTATS_API_KEY]: "k" },
  }) as unknown as Ctx;

beforeEach(() => {
  bypassRateLimitsForTests(false);
  resetRateLimitsForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("三条链共享一个队", () => {
  it("三条链各取一次 → 被摊开,不是各自满速", async () => {
    const at: number[] = [];
    const t0 = Date.now();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(JSON.stringify(solanaFixture), { status: 200 });
    });

    // 三个**不同的 provider 实例**(实际部署里就是三个 connector 各持一个)。
    const runs = Promise.all(
      ["solana", "sui", "cosmos"].map((chain) =>
        createCoinstatsProvider(chain).fetchBalances(ctx()),
      ),
    );
    await vi.runAllTimersAsync();
    await runs;

    // 额度 2 发/窗口 → 前两发同时走,第三发必须等下一个窗口。等到了就说明队是共享的。
    expect(at).toHaveLength(3);
    expect(at.filter((t) => t === 0)).toHaveLength(2);
    expect(Math.max(...at)).toBeGreaterThan(0);
  });

  it("反面:如果队没共享,三发就会一起出去 —— 这条钉住不是那样", async () => {
    const at: number[] = [];
    const t0 = Date.now();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      at.push(Date.now() - t0);
      return new Response(JSON.stringify(solanaFixture), { status: 200 });
    });
    const runs = Promise.all(
      ["solana", "sui", "cosmos"].map((chain) =>
        createCoinstatsProvider(chain).fetchBalances(ctx()),
      ),
    );
    await vi.runAllTimersAsync();
    await runs;
    expect(at.filter((t) => t === 0)).not.toHaveLength(3);
  });
});
