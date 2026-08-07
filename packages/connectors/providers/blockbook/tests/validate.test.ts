import type { ScriptType } from "@folio/bitcoin-derive";
import { noOutbound } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockbookProvider } from "../src";

// 契约的出口是 Effect(ADR 0035)。`failing` 拿**错误值本身** —— 不用 `.rejects`,
// 因为 `runPromise` 抛的是包了一层的 `FiberFailure`,断言看不见里面的 `_tag`。
const failing = (
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => Effect.runPromise(Effect.provide(Effect.flip(effect), noOutbound));

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError, ProviderNeeds>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, noOutbound));

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

// 新 FetchContext 形状:account.creds(AC:addressOrXpub + scriptType)+ creds(PC:空)。
// CredsOf 把两字段都作必填键(scriptType 值可为 undefined),故显式带上 scriptType 键。
function ctx(input: { addressOrXpub: string; scriptType?: ScriptType }) {
  return {
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("blockbookProvider.validateAccount", () => {
  it("地址:打 /address/,200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ADDR, balance: "0" }), { status: 200 }),
      );
    expect(await run(blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/address/");
  });

  it("xpub:打 /xpub/(basic),200 → true", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ address: ZPUB84, balance: "0" }), { status: 200 }),
      );
    expect(await run(blockbookProvider.validateAccount(ctx({ addressOrXpub: ZPUB84 })))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toContain("/xpub/");
  });

  // 契约(#240):够不到上游 → 抛 ProviderError(不压成 false),让调用方重试。
  it("端点全故障(5xx)→ 抛 UPSTREAM_ERROR(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const err = await failing(blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("429 → 抛 RATE_LIMITED(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const err = await failing(blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })));
    expect(err._tag).toBe("ConnectorRateLimitError");
  });

  // 服务端永久拒(4xx,如无效 xpub 的 400):客户端标 `retryable: false`,这一路必须透传到底 ——
  // 只按 code(UPSTREAM_ERROR)推断的话会被判成可重试,一个必然失败的 400 被反复打。
  // **这条钉的就是 `fromProviderError` 里「显式 retryable 压过 code」那一句**(第一版漏了,它当场红)。
  it("服务端 400(永久)→ 归「重试改变不了」那一类,不是「够不到上游」", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    const err = await failing(blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })));
    expect(err._tag).toBe("ConnectorFailure");
    expect(isRetryable(err)).toBe(false);
  });

  // 凭据本身不成立:xpub 解析不出来 → INVALID_CREDENTIALS → false(等也没用,不该重试)。
  it("非法扩展公钥(乱串)→ false,造 token 即失败", async () => {
    expect(
      await run(blockbookProvider.validateAccount(ctx({ addressOrXpub: "zpubGARBAGE" }))),
    ).toBe(false);
  });
});
