import { resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAccountCreds } from "../../src/lib/server/internal/connector-registry";

// 添加账户的探活。走 workers-pool 是因为 connector-registry 引 `cloudflare:workers` 的 env
// (PC 注入要读它)。打桩打在**全局 fetch** 上,测的是真实那条路(表单 → validateAccountCreds
// → provider → 出网),不是一个假 provider。用 evm connector(默认 provider 是 rabby,不要 key)。
//
// **契约已落地(#240):** `validateAccount` 现在把两类失败分开 —— 凭据被拒(401/403 → AUTH_FAILED)
// 返回 `false`;够不到上游(429 / 5xx / 网络故障)抛 retryable 的 `ProviderError`。于是 withRetry
// 这一层活了:传输故障会重试,凭据被拒不会(等也没用,而且拿着错凭据再打一次上游有害)。
// 下面这几条钉的是**这个行为**。

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

beforeEach(() => resetRateLimitsForTests());
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
  it("瞬时 429 → 重试一次并成功(rabby 抛 RATE_LIMITED,withRetry 再打一发)", async () => {
    const spy = scriptedFetch([429, 200]); // 第二发成功
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2); // 429 抛错 → 重试 → 200 通过
  });

  it("持续 429 → 重试用尽后失败(抛 ProviderError,不是压成 false)", async () => {
    const spy = scriptedFetch([429]); // 每发都 429
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(); // RATE_LIMITED 冒出去(不是 "could not verify")
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
});
