import type { ScriptType } from "@folio/bitcoin-derive";
import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { blockbookProvider } from "../../../src/connectors/bitcoin/provider";

// 契约(#240):凭据被拒 / xpub 解析不出来 → 成功返回 `false`;够不到上游 → 留在错误通道,
// 让调用方重试。这几条钉的是**那条分界**。
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ctx = (input: { addressOrXpub: string; scriptType?: ScriptType }) =>
  ({
    account: {
      id: "a1",
      label: "Cold",
      connectorId: "bitcoin",
      creds: { addressOrXpub: input.addressOrXpub, scriptType: input.scriptType },
    },
    creds: {},
  }) as never;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("validateAccount", () => {
  it("地址:打 /address/,200 → true", async () => {
    const stub = httpStub(() => json({ address: ADDR, balance: "0", unconfirmedBalance: "0" }));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })))).toBe(
      true,
    );
    expect(stub.calls[0].request.url.pathname).toContain("/address/");
  });

  it("xpub:打 /xpub/ 且只要 basic(探活不需要各地址明细)", async () => {
    const stub = httpStub(() => json({ address: ZPUB84, balance: "0", unconfirmedBalance: "0" }));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ZPUB84 })))).toBe(
      true,
    );
    expect(stub.calls[0].request.url.pathname).toContain("/xpub/");
    expect(stub.calls[0].request.url.searchParams.get("details")).toBe("basic");
  });

  it("凭据被拒(403)→ false,不进错误通道", async () => {
    const stub = httpStub(() => json({}, 403));
    expect(await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })))).toBe(
      false,
    );
  });

  it("端点全故障(5xx)→ 走错误通道(可重试),不压成 false", async () => {
    const stub = httpStub(() => json({}, 500));
    const err = await failing(
      stub,
      blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })),
    );
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("**服务端永久拒(400)→ 不可重试**", async () => {
    // 无效 xpub 之类的 400 换四个节点还是四个 400。老那版靠客户端标 `retryable: false` 表达这条;
    // 换成 Effect 客户端之后它只说「够不到上游」(可重试)—— 这条测试当场抓到了那个回归。
    // 判据搬到适配层:4xx 是「你给的东西不对」,重试改变不了。
    const stub = httpStub(() => json({}, 400));
    const err = await failing(
      stub,
      blockbookProvider.validateAccount(ctx({ addressOrXpub: ADDR })),
    );
    expect(isRetryable(err)).toBe(false);
  });

  it("非法扩展公钥(乱串)→ false,造 token 即失败(压根没出网)", async () => {
    const stub = httpStub(() => json({}));
    expect(
      await run(stub, blockbookProvider.validateAccount(ctx({ addressOrXpub: "zpubGARBAGE" }))),
    ).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});
