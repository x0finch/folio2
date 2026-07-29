import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { okxProvider } from "../src";

// okx **刻意没有速率闸**,这个文件就是钉住这件事的 —— 不然下一个人看到别的 provider 都有闸,
// 会顺手补一个上来。
//
// 判据是「有没有多个调用挤同一份额度」:okx 的额度按**账户自己那把 key** 算,而一次
// fetchBalances 只发 1 个请求、不并发。桶永远是满的,闸一次都拦不到 —— 那是装饰,不是保护。
// 而且加了还有害:两个账户会被塞进同一个桶白白串行化,它们本来花的是各自的额度。

type Ctx = Parameters<typeof okxProvider.fetchBalances>[0];
const ctx = (id = "a1"): Ctx =>
  ({
    account: {
      id,
      label: "OKX",
      connectorId: "okx",
      creds: { apiKey: "k", secret: "s", passphrase: "p" },
    },
    creds: {},
  }) as unknown as Ctx;

beforeEach(() => resetLimitsForTests());
afterEach(() => {
  setSleepForTests();
  vi.restoreAllMocks();
});

describe("okx 没有闸", () => {
  it("连发很多次都不等 —— 一次 sleep 都不该发生", async () => {
    const waits: number[] = [];
    setSleepForTests(async (ms) => void waits.push(ms));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ code: "0", data: [] }), { status: 200 }),
    );
    for (let i = 0; i < 20; i++) await okxProvider.fetchBalances(ctx());
    expect(waits).toEqual([]);
  });

  it("撞了 429 也不进冷却 —— 下一发照样出网(错的是那把 key,不是共享额度)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("", { status: 429 });
    });
    await expect(okxProvider.fetchBalances(ctx())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(okxProvider.fetchBalances(ctx("a2"))).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(calls).toBe(2); // 第二发真的出网了,不是被冷却拦下的
  });
});
