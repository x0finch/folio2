import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";

// 添加账户的探活。走 workers-pool 是因为 connector-registry 引 `cloudflare:workers` 的 env
// (PC 注入要读它)。打桩打在**全局 fetch** 上,测的是真实那条路(表单 → ConnectorRegistry.validate
// → provider → 出网),不是一个假 provider。用 evm connector(默认 provider 是 rabby,不要 key)。
//
// **契约已落地(#240):** `validateAccount` 把两类失败分开 —— 凭据被拒(401/403)成功返回 `false`;
// 够不到上游(429 / 5xx / 网络故障)走**错误通道**。于是重试这一层活了:传输故障会重试,
// 凭据被拒不会(等也没用,而且拿着错凭据再打一次上游有害)。下面这几条钉的是**这个行为**。
//
// 重试实现已从 `@folio/shared` 的手搓 `withRetry` 换成 Effect 的 `Schedule`(#377),
// **这几条断言一个字没改** —— 那正是「换实现不换行为」的证据。

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 探活现在是门票上的一个方法(#504 T14),所以这里补一句装配 + 发动。**断言一个字没改** ——
// 它测的是重试行为,而那件事跟「怎么拿到这个能力」无关。
const validateAccountCreds = (...args: Parameters<ConnectorRegistry["validate"]>): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(ConnectorRegistry, (r) => r.validate(...args)).pipe(
      Effect.provide(ConnectorRegistry.Default),
    ),
  );

afterEach(() => vi.restoreAllMocks());

// 按次序应答:第 n 次出网返回 statuses[n-1](用尽后重复最后一个)。每次都新建 Response
// (同一个实例的 body 只能读一次)。
function scriptedFetch(statuses: number[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return new Response(status === 200 ? "{}" : "", { status });
  });
}

describe("探活", () => {
  it("上游正常 → 通过", async () => {
    const spy = scriptedFetch([200]);
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("凭据本身不对(形状闸)→ 一次都不出网,等也没用", async () => {
    const spy = scriptedFetch([200]);
    await expect(
      validateAccountCreds("evm", { address: "not-an-address" }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("不要探活时压根不出网", async () => {
    const spy = scriptedFetch([200]);
    await expect(validateAccountCreds("evm", { address: ADDRESS })).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("契约落地:传输故障重试,凭据被拒不重试", () => {
  it("瞬时 429 → 重试一次并成功(rabby 报 RATE_LIMITED,重试再打一发)", async () => {
    const spy = scriptedFetch([429, 200]); // 第二发成功
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2); // 429 抛错 → 重试 → 200 通过
  });

  it("持续 429 → 重试用尽后失败(错误冒出去,不是压成 false)", async () => {
    const spy = scriptedFetch([429]); // 每发都 429
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(); // 限流错误冒出去(不是 "could not verify")
    expect(spy).toHaveBeenCalledTimes(2); // VALIDATE_RETRY_ATTEMPTS = 1 + 1 次重试
  });

  it("网络故障 → 重试用尽后失败", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("凭据被拒(403 → AUTH_FAILED)→ 一次就失败,不重试(等也没用)", async () => {
    const spy = scriptedFetch([403]);
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(/could not verify/); // provider 返回 false → 明确的凭据错误文案
    expect(spy).toHaveBeenCalledTimes(1); // false 不触发重试(只有抛 retryable 错才重试)
  });

  // **上游说要等的比我们肯等的久 → 一次就放弃,不重试。**
  //
  // 用户正盯着表单:夹到 1.5 秒再打大概率还是 429,白赔一次往返,不如立刻把错误交给表单。
  // 这条与**后台同步**那份策略刻意相反(那边没人等,所以夹住继续等)。
  //
  // 它是手搓 `withRetry` 的 `exceedsMaxWait: "throw"`,换成 `Schedule` 时差点丢掉 ——
  // 第一版写成了 clamp,四闸全绿也测不出来,因为**当时没有任何用例钉它**。补上。
  it("Retry-After 超过我们肯等的上限 → 一次就放弃(不夹到上限再打)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
      );
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // 没有第二发
  });
});
