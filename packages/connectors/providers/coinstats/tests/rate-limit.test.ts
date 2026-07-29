import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinstatsProvider } from "../src";
import { COINSTATS_API_KEY } from "../src/constants";
import solanaFixture from "./fixtures/solana.json";

// **一把 key 服务三个 connector**(sui / cosmos / solana),所以它们必须共享同一个闸 ——
// 花的是同一份额度。这是本文件要钉的东西:换成每个 provider 一个闸,三条链一起同步时
// 就是三倍超速,而免费档只有 2 请求/秒。

type Ctx = Parameters<ReturnType<typeof createCoinstatsProvider>["fetchBalances"]>[0];
const ctx = (): Ctx =>
  ({
    account: { id: "a1", label: "W", connectorId: "solana", creds: { address: "abc" } },
    creds: { [COINSTATS_API_KEY]: "k" },
  }) as unknown as Ctx;

beforeEach(() => resetLimitsForTests());
afterEach(() => {
  setSleepForTests();
  vi.restoreAllMocks();
});

// **每次都新建 Response** —— 同一个实例的 body 只能读一次,复用会让第二发变成 PARSE_ERROR。
function stubOk() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(solanaFixture), { status: 200 }));
}

describe("三条链共享一个闸", () => {
  it("sui / cosmos / solana 依次取数 → 被摊开,不是各自满速", async () => {
    const waits: number[] = [];
    setSleepForTests(async (ms) => void waits.push(ms));
    stubOk();

    // 三个**不同的 provider 实例**(实际部署里就是三个 connector 各持一个)。
    for (const chain of ["solana", "sui", "cosmos"]) {
      await createCoinstatsProvider(chain).fetchBalances(ctx());
    }

    // 容量 2 → 头两发直接走,第三发必须等。等到了就说明桶是共享的。
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it("一条链撞了 429 → 另外两条也一起收手(同一把 key 的额度)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
    await expect(createCoinstatsProvider("solana").fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    // 换一条链:压根不该出网 —— 冷却是挂在 key 上的,不是挂在 connector 上的。
    // 注意:vi.spyOn 对同一个函数返回的是**同一个** spy(带着上面那次调用的历史),所以要清一下。
    const spy = stubOk();
    spy.mockClear();
    await expect(createCoinstatsProvider("sui").fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
