import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import { type ConnectorError, isRetryable, type ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hyperliquidProvider } from "../../../src/connectors/hyperliquid/provider";
import fixture from "./fixtures/clearinghouse-state.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<typeof hyperliquidProvider.fetchBalances>[0];
const ctx = (address = ADDR): Ctx =>
  ({
    account: { id: "a1", label: "HL", connectorId: "hyperliquid", creds: { address } },
    creds: {},
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  it("POST /info,body 里带 type 与 user,再解析", async () => {
    const stub = httpStub(() => json(fixture));
    const { balances } = await run(stub, hyperliquidProvider.fetchBalances(ctx()));

    expect(balances.some((b) => b.kind === "perp_equity")).toBe(true);
    const sent = stub.calls[0].request;
    expect(sent.method).toBe("POST");
    expect(JSON.parse(String(sent.body))).toEqual({ type: "clearinghouseState", user: ADDR });
  });

  it("**没有闸** —— 连发 20 个账户不产生任何等待", async () => {
    // 这家上游按地址查、每账户一发,装闸拦不到东西还会把互不相干的账户排成一队白等。
    // 判据是**虚拟时钟走了多远**:走了 0ms 就是一次都没等过,与调度快慢无关(比数时刻稳)。
    const stub = httpStub(() => json(fixture));
    const elapsed = await runClient(
      stub,
      Effect.gen(function* () {
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) =>
            Effect.orDie(
              hyperliquidProvider.fetchBalances(ctx(`0x${String(i).padStart(40, "0")}`)),
            ),
          ),
          { concurrency: "unbounded" },
        );
        return yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      }),
    );
    expect(elapsed).toBe(0);
    expect(stub.calls).toHaveLength(20);
  });

  it("5xx → 够不到上游(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, hyperliquidProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("429 → 限流(可重试)", async () => {
    const stub = httpStub(() => json({}, { status: 429 }));
    const err = await failing(stub, hyperliquidProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorRateLimitError");
  });
});

describe("validateAccount", () => {
  it("200 → true(未交易过的地址也是 200 + 空状态)", async () => {
    const stub = httpStub(() => json({ marginSummary: {}, assetPositions: [] }));
    expect(await run(stub, hyperliquidProvider.validateAccount(ctx()))).toBe(true);
  });

  it("够不到上游 → 走错误通道,不压成 false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    const err = await failing(stub, hyperliquidProvider.validateAccount(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });
});
