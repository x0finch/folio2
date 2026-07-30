import { resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAccountCreds } from "../../src/lib/server/internal/connector-registry";

// 添加账户的探活。走 workers-pool 是因为 connector-registry 引 `cloudflare:workers` 的 env
// (PC 注入要读它)。打桩打在**全局 fetch** 上,测的是真实那条路(表单 → validateAccountCreds
// → provider → 出网),不是一个假 provider。用 evm connector(默认 provider 是 rabby,不要 key)。
//
// ⚠️ **这里的重试目前一次都不会触发,而且这是本文件最重要的事实。**
//
// `BalanceProvider.validateAccount` 的签名是 `Promise<boolean>`,而**七个 provider 无一例外**
// 都写成 `try { return res.ok } catch { return false }` —— 429、5xx、网络故障、凭据不对,
// 全都压成同一个 `false`。于是 withRetry 收不到任何错误对象,也就无从判断 retryable。
//
// 为什么仍然把 withRetry 接上:它在对的那一层,而且是後续那步(让 provider 对「传输故障」抛
// ProviderError、只对「凭据被拒」返回 false)唯一需要的前提 —— 那一步一落地,这里立刻就活了。
// 为什么**不**改成「`false` 也重试」:`false` 是歧义的,里面混着「这个 key 就是错的」——
// 那是最常见的失败,给它多赔一个往返 + 一次等待,还会拿着错凭据再打一次上游(binance 那种
// 会把重复认证失败当探测)。
//
// 下面这几条钉的就是**现状**,不是理想状态。别把它们当 bug 改掉 —— 要改的是 provider 的契约。

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

describe("现状:provider 把一切压成 false,于是重试触发不了", () => {
  it("瞬时 429 → 一次就失败(**不是**期望的行为,是待修的契约)", async () => {
    const spy = scriptedFetch([429, 200]); // 第二发本该成功
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(/could not verify/);
    expect(spy).toHaveBeenCalledTimes(1); // 没有第二发 —— rabby 把 429 压成了 false
  });

  it("网络故障 → 同样一次就失败", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(
      validateAccountCreds("evm", { address: ADDRESS }, { liveness: true }),
    ).rejects.toThrow(/could not verify/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("反面:provider 抛**不可重试**的错误 → 一次都不重试(用户填错了,等也没用)", async () => {
    // 验收单上这条今天在 app 这一层造不出来(没有 provider 会抛),所以直接验这一层用的那组参数:
    // 默认判据只认 `retryable === true`,`INVALID_CREDENTIALS` 那种不带这个标记的一次都不重。
    // 规则层面的覆盖在 packages/ratelimit/tests/retry.test.ts。
    const { withRetry } = await import("@folio/shared");
    let calls = 0;
    const rejected = async () => {
      calls++;
      throw Object.assign(new Error("INVALID_CREDENTIALS"), { retryable: false });
    };
    await expect(
      withRetry(rejected, { attempts: 2, maxWaitMs: 1500, baseMs: 1, sleep: async () => {} }),
    ).rejects.toThrow(/INVALID_CREDENTIALS/);
    expect(calls).toBe(1);
  });

  it("但只要 provider 肯抛 retryable 错误,这一层立刻就会重试", async () => {
    // 直接验 withRetry 那一层的接线:manual connector 没有 provider(探活直接放行),所以拿
    // evm 那条路没法造出「抛错的 provider」——用一个抛 retryable 错的假调用证明参数是对的。
    const { withRetry } = await import("@folio/shared");
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("429"), { retryable: true });
      return true;
    };
    await expect(
      withRetry(flaky, { attempts: 2, maxWaitMs: 1500, baseMs: 1, sleep: async () => {} }),
    ).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});
