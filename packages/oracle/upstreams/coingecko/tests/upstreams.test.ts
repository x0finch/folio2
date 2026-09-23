import { runClient } from "@folio/client-core/testing";
import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { FxUpstream, Namer, PlatformUpstream, TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coinGeckoFxUpstreamLayer } from "../src/fx";
import { coinGeckoNamerLayer } from "../src/layer";
import { coinGeckoPlatformUpstreamLayer } from "../src/platform";
import { coinGeckoTokenUpstreamLayer } from "../src/upstream";
import { coinGeckoUpstreamLayers } from "../src/upstreams";
import { routed } from "./harness";

// **三个端口一起挂 → 一次构建只建一个 client。** 装配点(apps/web 的 oracle.ts)每次请求都把
// 三个端口挂上,建 client 不是免费的(profile 里每次约 1.7ms CPU)。layer memoisation 按**引用**
// 认,所以要紧的是三格挂在同一个 `transport` 引用上 —— 这里数的就是「client 真被建了几次」。

// 包一层计数:每次这张 layer 真被**建**(不是被调用出一个描述)就 +1。
const countBuilds = () => {
  const real = CoinGeckoClient.layer;
  const counter = { builds: 0 };
  vi.spyOn(CoinGeckoClient, "layer").mockImplementation((config?: CoinGeckoConfig) =>
    Layer.tap(real(config), () =>
      Effect.sync(() => {
        counter.builds += 1;
      }),
    ),
  );
  return counter;
};

// 四张票都拿一遍 —— 拿得到就说明图建完了,顺带钉住四格各自接对了端口。
const idsFrom = (layer: Layer.Layer<TokenUpstream | FxUpstream | PlatformUpstream | Namer>) =>
  runClient(
    routed({}).http,
    Effect.all([TokenUpstream, FxUpstream, PlatformUpstream, Namer]).pipe(
      Effect.map((ports) => ports.map((p) => p.id)),
      Effect.provide(layer),
    ),
    "none",
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coinGeckoUpstreamLayers", () => {
  it("三个端口共用一个 client:一次构建只建一份", async () => {
    const counter = countBuilds();
    const cg = coinGeckoUpstreamLayers({ apiKey: "k" });

    const ids = await idsFrom(Layer.mergeAll(cg.token, cg.fx, cg.platform, cg.namer));

    expect(ids).toEqual(["coingecko", "coingecko", "coingecko", "coingecko"]);
    expect(counter.builds).toBe(1);
  });

  // 对照组:各自的工厂各 `transport(config)` 一次 —— 引用不同,memo 认不出,哪怕 config 相同。
  // 这正是装配点以前的写法;留着这条,是为了让「为什么要 `coinGeckoUpstreamLayers`」有据可查。
  it("对照:三个单端口工厂各建一份", async () => {
    const counter = countBuilds();
    const config = { apiKey: "k" };

    await idsFrom(
      Layer.mergeAll(
        coinGeckoTokenUpstreamLayer(config),
        coinGeckoFxUpstreamLayer(config),
        coinGeckoPlatformUpstreamLayer(config),
        coinGeckoNamerLayer,
      ),
    );

    expect(counter.builds).toBe(3);
  });
});
